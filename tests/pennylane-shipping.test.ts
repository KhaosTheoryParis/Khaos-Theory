import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import test from "node:test";
import type Stripe from "stripe";
import type { OrdersDatabase, OrdersPreparedStatement } from "../app/services/orders";
import {
  getPennylaneErrorDetails,
  syncPaidCheckoutSessionToPennylane,
} from "../app/services/pennylane";
import { processStripeEvent } from "../app/services/stripe-events";

const productMetadata = {
  catalog_id: "geometry",
  order_line_id: "11111111-1111-4111-8111-111111111111",
  size_fr: "58",
  pennylane_vat_rate: "exempt",
  schema_version: "1",
};

const migrations = [
  "0001_create_orders.sql",
  "0002_create_refund_operations.sql",
  "0003_track_refund_credit_notes.sql",
  "0004_create_stripe_event_registry.sql",
  "0005_add_permanent_stripe_event_failure.sql",
  "0006_harden_refund_operations.sql",
  "0007_create_multi_line_refund_operations.sql",
  "0008_add_order_customer_name.sql",
  "0009_add_shipping_to_orders.sql",
  "0010_add_shipping_refunds.sql",
];

class StatementAdapter implements OrdersPreparedStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: Array<string | number | null> = [],
  ) {}

  bind(...values: Array<string | number | null>) {
    return new StatementAdapter(this.statement, values);
  }

  async first<T>() {
    return (this.statement.get(...this.values) as T | undefined) ?? null;
  }

  async all<T>() {
    return { results: this.statement.all(...this.values) as T[], success: true };
  }

  async run() {
    const result = this.statement.run(...this.values);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

class DatabaseAdapter implements OrdersDatabase {
  readonly sqlite = new DatabaseSync(":memory:");

  constructor() {
    for (const migration of migrations) {
      this.sqlite.exec(readFileSync(`migrations/${migration}`, "utf8"));
    }
  }

  prepare(query: string) {
    return new StatementAdapter(this.sqlite.prepare(query));
  }

  async batch(statements: OrdersPreparedStatement[]) {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

function session({
  productsSubtotal = 25_000,
  shippingAmount,
  amountTotal = productsSubtotal + (shippingAmount ?? 0),
  schemaVersion = "1",
}: {
  productsSubtotal?: number;
  shippingAmount?: number;
  amountTotal?: number;
  schemaVersion?: string | null;
} = {}) {
  const hasShipping = shippingAmount !== undefined;
  return {
    id: "cs_test_pennylaneShipping",
    object: "checkout.session",
    payment_status: "paid",
    payment_intent: "pi_pennylaneShipping",
    currency: "eur",
    amount_subtotal: productsSubtotal,
    amount_total: amountTotal,
    metadata: schemaVersion === null ? {} : { schema_version: schemaVersion },
    created: 1_788_091_200,
    customer_email: "shipping@example.test",
    customer_details: {
      email: "shipping@example.test",
      individual_name: "Shipping Test",
      name: "Shipping Test",
      business_name: null,
      phone: null,
      tax_exempt: "none",
      tax_ids: [],
      address: {
        city: "Paris",
        country: "FR",
        line1: "1 rue de Test",
        line2: null,
        postal_code: "75001",
        state: null,
      },
    },
    shipping_cost: hasShipping ? {
      amount_subtotal: shippingAmount,
      amount_tax: 0,
      amount_total: shippingAmount,
      shipping_rate: "shr_test",
    } : null,
    total_details: {
      amount_discount: 0,
      amount_shipping: shippingAmount ?? 0,
      amount_tax: 0,
    },
    collected_information: {
      business_name: null,
      individual_name: "Shipping Test",
      shipping_details: hasShipping ? {
        name: "Shipping Test",
        address: { city: "Paris", country: "FR", line1: "1 rue de Test", postal_code: "75001" },
      } : null,
    },
  } as unknown as Stripe.Checkout.Session;
}

function lineItem(productsSubtotal = 25_000) {
  return {
    id: "li_pennylaneShipping",
    object: "item",
    amount_discount: 0,
    amount_subtotal: productsSubtotal,
    amount_tax: 0,
    amount_total: productsSubtotal,
    currency: "eur",
    description: "Geometry — FR 58",
    metadata: productMetadata,
    quantity: 1,
    price: {
      id: "price_pennylaneShipping",
      object: "price",
      unit_amount: productsSubtotal,
      product: {
        id: "prod_pennylaneShipping",
        object: "product",
        deleted: false,
        metadata: productMetadata,
      },
    },
  } as unknown as Stripe.LineItem;
}

function stripeFor(checkoutSession: Stripe.Checkout.Session, item = lineItem()) {
  return {
    checkout: {
      sessions: {
        retrieve: async () => checkoutSession,
        listLineItems: () => ({ autoPagingToArray: async () => [item] }),
      },
    },
    paymentIntents: {
      retrieve: async () => ({
        id: "pi_pennylaneShipping",
        object: "payment_intent",
        status: "succeeded",
        currency: "eur",
        amount_received: checkoutSession.amount_total,
      }),
    },
  } as unknown as Stripe;
}

type InvoiceLinePayload = {
  label: string;
  quantity: number;
  unit: string;
  raw_currency_unit_price: string;
  vat_rate: string;
};

function cents(amount: string) {
  return Math.round(Number(amount) * 100);
}

function mockPennylane() {
  let invoiceCreated = false;
  let invoiceCreateCalls = 0;
  let fetchCalls = 0;
  let invoiceLines: InvoiceLinePayload[] = [];
  const invoicePayloads: Array<{ invoice_lines: InvoiceLinePayload[]; external_reference: string }> = [];

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
  const invoice = () => ({
    id: 99,
    currency_amount: invoiceLines
      .reduce((total, line) => total + cents(line.raw_currency_unit_price) * line.quantity, 0)
      .toFixed(0)
      .replace(/(\d{2})$/, ".$1"),
    paid: true,
    draft: false,
    external_reference: "stripe_checkout_cs_test_pennylaneShipping",
  });

  const fetchMock = async (input: string | URL | Request, init?: RequestInit) => {
    fetchCalls += 1;
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = init?.method?.toUpperCase() ?? "GET";

    if (url.pathname === "/api/external/v2/me") {
      return json({ company: { reg_no: "sandbox-test" } });
    }
    if (url.pathname === "/api/external/v2/customer_invoices" && method === "GET") {
      return json({ items: invoiceCreated ? [invoice()] : [] });
    }
    if (url.pathname === "/api/external/v2/customers" && method === "GET") {
      return json({ items: [{ id: 42 }] });
    }
    if (url.pathname === "/api/external/v2/customer_invoices" && method === "POST") {
      invoiceCreateCalls += 1;
      const payload = JSON.parse(String(init?.body)) as {
        invoice_lines: InvoiceLinePayload[];
        external_reference: string;
      };
      invoicePayloads.push(payload);
      invoiceLines = payload.invoice_lines;
      invoiceCreated = true;
      return json(invoice());
    }
    if (url.pathname === "/api/external/v2/customer_invoices/99/invoice_lines") {
      return json({
        items: invoiceLines.map((line, index) => ({
          id: index + 1,
          ...line,
          quantity: String(line.quantity),
          currency_amount: (cents(line.raw_currency_unit_price) * line.quantity / 100).toFixed(2),
        })),
      });
    }
    if (url.pathname === "/api/external/v2/customer_invoices/99" && method === "GET") {
      return json(invoice());
    }
    if (url.pathname === "/api/external/v2/customer_invoices/99/send_by_email" && method === "POST") {
      return new Response(null, { status: 204 });
    }

    throw new Error(`Unexpected mocked Pennylane request: ${method} ${url.pathname}`);
  };

  return {
    fetchMock,
    get fetchCalls() { return fetchCalls; },
    get invoiceCreateCalls() { return invoiceCreateCalls; },
    get invoiceLines() { return invoiceLines; },
    get invoicePayloads() { return invoicePayloads; },
  };
}

async function withPennylaneMock<T>(mock: ReturnType<typeof mockPennylane>, run: () => Promise<T>) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock.fetchMock as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("a current order creates the same product-only invoice as before", async () => {
  const checkoutSession = session();
  const mock = mockPennylane();
  const result = await withPennylaneMock(mock, () => syncPaidCheckoutSessionToPennylane({
    stripe: stripeFor(checkoutSession),
    sessionId: checkoutSession.id,
    token: "fake-pennylane-token",
  }));

  assert.equal(result.shipping, null);
  assert.equal(mock.invoiceCreateCalls, 1);
  assert.deepEqual(mock.invoicePayloads[0]?.invoice_lines, [{
    label: "Geometry — FR 58",
    quantity: 1,
    unit: "piece",
    raw_currency_unit_price: "250",
    vat_rate: "exempt",
  }]);
});

test("paid shipping adds exactly one exempt bilingual shipping line", async () => {
  const checkoutSession = session({ productsSubtotal: 39_000, shippingAmount: 1_000 });
  const mock = mockPennylane();
  const result = await withPennylaneMock(mock, () => syncPaidCheckoutSessionToPennylane({
    stripe: stripeFor(checkoutSession, lineItem(39_000)),
    sessionId: checkoutSession.id,
    token: "fake-pennylane-token",
  }));

  assert.equal(result.amount, 40_000);
  assert.equal(result.shipping?.shippingAmount, 1_000);
  assert.equal(mock.invoiceLines.length, 2);
  assert.deepEqual(mock.invoiceLines[1], {
    label: "Livraison sécurisée / Secure shipping",
    quantity: 1,
    unit: "piece",
    raw_currency_unit_price: "10",
    vat_rate: "exempt",
  });
  assert.equal(
    mock.invoiceLines.reduce(
      (total, invoiceLine) => total + cents(invoiceLine.raw_currency_unit_price) * invoiceLine.quantity,
      0,
    ),
    result.amount,
  );
  assert.equal(
    mock.invoicePayloads[0]?.external_reference,
    "stripe_checkout_cs_test_pennylaneShipping",
  );
});

test("free shipping creates no zero-value Pennylane line", async () => {
  const checkoutSession = session({ productsSubtotal: 40_000, shippingAmount: 0 });
  const mock = mockPennylane();
  const result = await withPennylaneMock(mock, () => syncPaidCheckoutSessionToPennylane({
    stripe: stripeFor(checkoutSession, lineItem(40_000)),
    sessionId: checkoutSession.id,
    token: "fake-pennylane-token",
  }));

  assert.equal(result.amount, 40_000);
  assert.equal(result.shipping?.shippingAmount, 0);
  assert.equal(mock.invoiceLines.length, 1);
});

test("an inconsistent shipping total fails before any Pennylane request", async () => {
  const checkoutSession = session({ shippingAmount: 1_000, amountTotal: 25_999 });
  const mock = mockPennylane();
  await assert.rejects(
    withPennylaneMock(mock, () => syncPaidCheckoutSessionToPennylane({
      stripe: stripeFor(checkoutSession),
      sessionId: checkoutSession.id,
      token: "fake-pennylane-token",
    })),
    (error) => getPennylaneErrorDetails(error).code === "STRIPE_SHIPPING_TOTAL_MISMATCH",
  );
  assert.equal(mock.fetchCalls, 0);
  assert.equal(mock.invoiceCreateCalls, 0);
});

test("an invalid shipping amount fails before any Pennylane request", async () => {
  const checkoutSession = session({ shippingAmount: -1 });
  const mock = mockPennylane();
  await assert.rejects(
    withPennylaneMock(mock, () => syncPaidCheckoutSessionToPennylane({
      stripe: stripeFor(checkoutSession),
      sessionId: checkoutSession.id,
      token: "fake-pennylane-token",
    })),
    (error) => getPennylaneErrorDetails(error).code === "INVALID_STRIPE_SHIPPING_AMOUNT",
  );
  assert.equal(mock.fetchCalls, 0);
  assert.equal(mock.invoiceCreateCalls, 0);
});

test("a shipping replay reuses one invoice and verifies one shipping line", async () => {
  const checkoutSession = session({ shippingAmount: 1_000 });
  const mock = mockPennylane();
  const synchronize = () => syncPaidCheckoutSessionToPennylane({
    stripe: stripeFor(checkoutSession),
    sessionId: checkoutSession.id,
    token: "fake-pennylane-token",
  });

  const first = await withPennylaneMock(mock, synchronize);
  const replay = await withPennylaneMock(mock, synchronize);
  assert.equal(first.status, "created");
  assert.equal(replay.status, "already_exists");
  assert.equal(mock.invoiceCreateCalls, 1);
  assert.equal(mock.invoiceLines.filter(
    (line) => line.label === "Livraison sécurisée / Secure shipping",
  ).length, 1);
});

test("a schema-less historical order keeps shipping NULL and no shipping line", async () => {
  const checkoutSession = session({ schemaVersion: null });
  const mock = mockPennylane();
  const result = await withPennylaneMock(mock, () => syncPaidCheckoutSessionToPennylane({
    stripe: stripeFor(checkoutSession),
    sessionId: checkoutSession.id,
    token: "fake-pennylane-token",
  }));
  assert.equal(result.shipping, null);
  assert.equal(mock.invoiceLines.length, 1);
});

function checkoutCompletedEvent(checkoutSession: Stripe.Checkout.Session) {
  return {
    id: `evt_${checkoutSession.id}`,
    object: "event",
    api_version: "2026-08-27.basil",
    created: checkoutSession.created,
    data: { object: checkoutSession },
    livemode: false,
    pending_webhooks: 0,
    request: null,
    type: "checkout.session.completed",
  } as unknown as Stripe.Event;
}

test("checkout.session.completed persists normalized paid shipping", async () => {
  const checkoutSession = session({ productsSubtotal: 39_000, shippingAmount: 1_000 });
  const stripe = stripeFor(checkoutSession, lineItem(39_000));
  const db = new DatabaseAdapter();
  const mock = mockPennylane();

  await withPennylaneMock(mock, () => processStripeEvent({
    event: checkoutCompletedEvent(checkoutSession),
    env: {
      STRIPE_SECRET_KEY: "sk_test_not_real",
      PENNYLANE_API_TOKEN: "fake-pennylane-token",
      DB: db,
    },
    stripe,
    trace: () => undefined,
  }));

  const row = db.sqlite.prepare(
    `SELECT products_subtotal, shipping_amount, shipping_country,
      shipping_zone, amount_total FROM orders`,
  ).get();
  assert.deepEqual(
    [row?.products_subtotal, row?.shipping_amount, row?.shipping_country,
      row?.shipping_zone, row?.amount_total],
    [39_000, 1_000, "FR", "FR", 40_000],
  );
});

test("checkout.session.completed keeps a legacy order shipping-free", async () => {
  const checkoutSession = session();
  const db = new DatabaseAdapter();
  const mock = mockPennylane();

  await withPennylaneMock(mock, () => processStripeEvent({
    event: checkoutCompletedEvent(checkoutSession),
    env: {
      STRIPE_SECRET_KEY: "sk_test_not_real",
      PENNYLANE_API_TOKEN: "fake-pennylane-token",
      DB: db,
    },
    stripe: stripeFor(checkoutSession),
    trace: () => undefined,
  }));

  const row = db.sqlite.prepare(
    `SELECT products_subtotal, shipping_amount, shipping_country,
      shipping_zone, amount_total FROM orders`,
  ).get();
  assert.deepEqual(
    [row?.products_subtotal, row?.shipping_amount, row?.shipping_country,
      row?.shipping_zone, row?.amount_total],
    [null, null, null, null, 25_000],
  );
});
