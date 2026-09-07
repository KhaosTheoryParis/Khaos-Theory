import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import test from "node:test";
import type Stripe from "stripe";
import {
  getOrderPersistenceErrorDetails,
  persistPaidOrder,
  type OrdersDatabase,
  type OrdersPreparedStatement,
  type PersistOrderInput,
} from "../app/services/orders";
import { CURRENT_TERMS_VERSION } from "../app/services/checkout-terms";
import { resolveCheckoutShipping } from "../app/services/stripe-checkout-shipping";

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
  "0011_add_order_terms_acceptance.sql",
  "0012_add_order_checkout_locale.sql",
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

test("migration 0011 preserves existing orders and leaves historical acceptance NULL", () => {
  const sqlite = new DatabaseSync(":memory:");
  for (const migration of migrations.slice(0, -2)) {
    sqlite.exec(readFileSync(`migrations/${migration}`, "utf8"));
  }
  sqlite.prepare(
    `INSERT INTO orders (
      id, stripe_checkout_session_id, stripe_payment_intent_id,
      pennylane_invoice_id, customer_email, currency, amount_total,
      status, schema_version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "historical-order",
    "cs_test_historicalTerms",
    "pi_historicalTerms",
    "invoice-historical-terms",
    "historical@example.test",
    "eur",
    25_000,
    "paid",
    1,
    "2026-08-30T12:00:00.000Z",
    "2026-08-30T12:00:00.000Z",
  );

  sqlite.exec(readFileSync("migrations/0011_add_order_terms_acceptance.sql", "utf8"));
  sqlite.exec(readFileSync("migrations/0012_add_order_checkout_locale.sql", "utf8"));
  const row = sqlite.prepare(
    "SELECT terms_version, terms_accepted_at, checkout_locale FROM orders WHERE id = ?",
  ).get("historical-order");
  assert.deepEqual(
    [row?.terms_version, row?.terms_accepted_at, row?.checkout_locale],
    [null, null, null],
  );
});

function order(
  shipping: PersistOrderInput["shipping"] = null,
  termsAcceptance: PersistOrderInput["termsAcceptance"] = null,
  checkoutLocale: PersistOrderInput["checkoutLocale"] = "fr",
): PersistOrderInput {
  return {
    stripeCheckoutSessionId: "cs_test_shippingPersistence",
    stripePaymentIntentId: "pi_shippingPersistence",
    pennylaneInvoiceId: "invoice-shipping-persistence",
    customerName: null,
    customerEmail: "shipping@example.test",
    currency: "eur",
    amountTotal: shipping ? shipping.productsSubtotal + shipping.shippingAmount : 25_000,
    shipping,
    status: "paid",
    schemaVersion: 1,
    createdAt: "2026-08-30T12:00:00.000Z",
    checkoutLocale,
    termsAcceptance,
    lines: [{
      orderLineId: "11111111-1111-4111-8111-111111111111",
      stripeLineItemId: "li_shippingPersistence",
      pennylaneInvoiceLineId: "invoice-line-shipping-persistence",
      catalogId: "geometry",
      sizeFr: "58",
      quantity: shipping?.productsSubtotal === 40_000 ? 2 : 1,
      unitAmount: shipping?.productsSubtotal === 40_000 ? 20_000 : 25_000,
    }],
  };
}

test("checkout locale fr and en are persisted on new orders", async () => {
  const db = new DatabaseAdapter();
  const french = order(null, null, "fr");
  const english = order(null, null, "en");
  english.stripeCheckoutSessionId = "cs_test_checkoutLocaleEn";
  english.stripePaymentIntentId = "pi_checkoutLocaleEn";
  english.pennylaneInvoiceId = "invoice-checkout-locale-en";
  english.lines = [{
    ...english.lines[0],
    orderLineId: "33333333-3333-4333-8333-333333333333",
    stripeLineItemId: "li_checkoutLocaleEn",
    pennylaneInvoiceLineId: "invoice-line-checkout-locale-en",
  }];

  await persistPaidOrder(db, french);
  await persistPaidOrder(db, english);
  const rows = db.sqlite.prepare(
    "SELECT checkout_locale FROM orders ORDER BY stripe_checkout_session_id",
  ).all() as Array<{ checkout_locale: string | null }>;
  assert.deepEqual(rows.map((row) => row.checkout_locale), ["en", "fr"]);
});

test("a new order rejects an absent or invalid checkout locale", async () => {
  const absent = order(null, null, null);
  await assert.rejects(
    persistPaidOrder(new DatabaseAdapter(), absent),
    (error) => getOrderPersistenceErrorDetails(error).code === "CHECKOUT_LOCALE_REQUIRED",
  );

  const invalid = order(null, null, "de" as unknown as PersistOrderInput["checkoutLocale"]);
  await assert.rejects(
    persistPaidOrder(new DatabaseAdapter(), invalid),
    (error) => getOrderPersistenceErrorDetails(error).code === "INVALID_ORDER_PERSISTENCE_INPUT",
  );
});

test("current terms acceptance is persisted while historical orders remain nullable", async () => {
  const db = new DatabaseAdapter();
  const historical = order();
  await persistPaidOrder(db, historical);

  const historicalRow = db.sqlite.prepare(
    "SELECT terms_version, terms_accepted_at FROM orders WHERE stripe_checkout_session_id = ?",
  ).get(historical.stripeCheckoutSessionId);
  assert.deepEqual(
    [historicalRow?.terms_version, historicalRow?.terms_accepted_at],
    [null, null],
  );

  const accepted = order(null, {
    termsVersion: CURRENT_TERMS_VERSION,
    termsAcceptedAt: "2026-09-07T10:11:12.000Z",
  });
  accepted.stripeCheckoutSessionId = "cs_test_termsPersistence";
  accepted.stripePaymentIntentId = "pi_termsPersistence";
  accepted.pennylaneInvoiceId = "invoice-terms-persistence";
  accepted.lines = [{
    ...accepted.lines[0],
    orderLineId: "22222222-2222-4222-8222-222222222222",
    stripeLineItemId: "li_termsPersistence",
    pennylaneInvoiceLineId: "invoice-line-terms-persistence",
  }];
  await persistPaidOrder(db, accepted);

  const acceptedRow = db.sqlite.prepare(
    "SELECT terms_version, terms_accepted_at FROM orders WHERE stripe_checkout_session_id = ?",
  ).get(accepted.stripeCheckoutSessionId);
  assert.deepEqual(
    [acceptedRow?.terms_version, acceptedRow?.terms_accepted_at],
    [CURRENT_TERMS_VERSION, "2026-09-07T10:11:12.000Z"],
  );
});

test("order persistence rejects a client-selected or malformed terms acceptance", async () => {
  const db = new DatabaseAdapter();
  const invalid = order(null, {
    termsVersion: "1900-01",
    termsAcceptedAt: "not-a-timestamp",
  } as unknown as PersistOrderInput["termsAcceptance"]);

  await assert.rejects(
    persistPaidOrder(db, invalid),
    (error) => getOrderPersistenceErrorDetails(error).code === "INVALID_ORDER_PERSISTENCE_INPUT",
  );
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM orders").get()?.count, 0);
});

function stripeSession({
  productsSubtotal = 25_000,
  shippingAmount = 1_000,
  amountTotal = productsSubtotal + shippingAmount,
  country = "FR",
  totalDetailsShipping = shippingAmount,
  amountDiscount = 0,
  amountTax = 0,
  shippingTax = 0,
}: {
  productsSubtotal?: number;
  shippingAmount?: number;
  amountTotal?: number;
  country?: string | null;
  totalDetailsShipping?: number | null;
  amountDiscount?: number;
  amountTax?: number;
  shippingTax?: number;
} = {}) {
  return {
    amount_subtotal: productsSubtotal,
    amount_total: amountTotal,
    shipping_cost: {
      amount_subtotal: shippingAmount,
      amount_tax: shippingTax,
      amount_total: shippingAmount,
      shipping_rate: "shr_test",
    },
    total_details: {
      amount_discount: amountDiscount,
      amount_shipping: totalDetailsShipping,
      amount_tax: amountTax,
    },
    collected_information: {
      business_name: null,
      individual_name: null,
      shipping_details: country === null ? null : {
        name: "Test",
        address: { country, line1: "Test" },
      },
    },
  } as unknown as Stripe.Checkout.Session;
}

function currentSessionWithoutShipping() {
  return {
    amount_subtotal: 25_000,
    amount_total: 25_000,
    shipping_cost: null,
    total_details: {
      amount_discount: 0,
      amount_shipping: 0,
      amount_tax: 0,
    },
    collected_information: {
      business_name: null,
      individual_name: null,
      shipping_details: null,
    },
  } as unknown as Stripe.Checkout.Session;
}

test("the current Stripe session shape remains explicitly shipping-free", () => {
  assert.equal(resolveCheckoutShipping(currentSessionWithoutShipping(), 25_000), null);
});

test("a current checkout without shipping persists NULL shipping fields", async () => {
  const db = new DatabaseAdapter();
  await persistPaidOrder(db, order());
  const row = db.sqlite.prepare(
    "SELECT products_subtotal, shipping_amount, shipping_country, shipping_zone FROM orders",
  ).get();
  assert.equal(row?.products_subtotal, null);
  assert.equal(row?.shipping_amount, null);
  assert.equal(row?.shipping_country, null);
  assert.equal(row?.shipping_zone, null);
});

test("a paid French shipping quote is normalized and persisted", async () => {
  const shipping = resolveCheckoutShipping(stripeSession(), 25_000);
  assert.deepEqual(shipping, {
    productsSubtotal: 25_000,
    shippingAmount: 1_000,
    shippingCountry: "FR",
    shippingZone: "FR",
  });
  const db = new DatabaseAdapter();
  await persistPaidOrder(db, order(shipping));
  const row = db.sqlite.prepare(
    "SELECT products_subtotal, shipping_amount, shipping_country, shipping_zone, amount_total FROM orders",
  ).get();
  assert.deepEqual(
    [row?.products_subtotal, row?.shipping_amount, row?.shipping_country, row?.shipping_zone, row?.amount_total],
    [25_000, 1_000, "FR", "FR", 26_000],
  );
});

test("free French shipping preserves the product subtotal and total", () => {
  assert.deepEqual(resolveCheckoutShipping(stripeSession({
    productsSubtotal: 40_000,
    shippingAmount: 0,
  }), 40_000), {
    productsSubtotal: 40_000,
    shippingAmount: 0,
    shippingCountry: "FR",
    shippingZone: "FR",
  });
});

test("a 390 euro product subtotal plus shipping normalizes to 400 euros", () => {
  assert.deepEqual(resolveCheckoutShipping(stripeSession({
    productsSubtotal: 39_000,
    shippingAmount: 1_000,
  }), 39_000), {
    productsSubtotal: 39_000,
    shippingAmount: 1_000,
    shippingCountry: "FR",
    shippingZone: "FR",
  });
});

test("shipping validation rejects an inconsistent session total", () => {
  assert.throws(
    () => resolveCheckoutShipping(stripeSession({ amountTotal: 25_999 }), 25_000),
    /STRIPE_SHIPPING_TOTAL_MISMATCH/,
  );
});

test("shipping validation rejects negative and non-integer amounts", () => {
  assert.throws(
    () => resolveCheckoutShipping(stripeSession({ shippingAmount: -1 }), 25_000),
    /INVALID_STRIPE_SHIPPING_AMOUNT/,
  );
  assert.throws(
    () => resolveCheckoutShipping(stripeSession({ shippingAmount: 1.5 }), 25_000),
    /INVALID_STRIPE_SHIPPING_AMOUNT/,
  );
});

test("shipping validation accepts only France and requires its address", () => {
  assert.throws(
    () => resolveCheckoutShipping(stripeSession({ country: "DE" }), 25_000),
    /UNSUPPORTED_SHIPPING_COUNTRY/,
  );
  assert.throws(
    () => resolveCheckoutShipping(stripeSession({ country: null }), 25_000),
    /UNSUPPORTED_SHIPPING_COUNTRY/,
  );
});

test("shipping validation rejects contradictory Stripe representations", () => {
  assert.throws(
    () => resolveCheckoutShipping(stripeSession({ totalDetailsShipping: 999 }), 25_000),
    /STRIPE_SHIPPING_TOTAL_MISMATCH/,
  );
});

test("shipping validation rejects unsupported discounts and taxes", () => {
  assert.throws(
    () => resolveCheckoutShipping(stripeSession({ amountDiscount: 1 }), 25_000),
    /STRIPE_SHIPPING_TOTAL_MISMATCH/,
  );
  assert.throws(
    () => resolveCheckoutShipping(stripeSession({ amountTax: 1 }), 25_000),
    /STRIPE_SHIPPING_TOTAL_MISMATCH/,
  );
  assert.throws(
    () => resolveCheckoutShipping(stripeSession({ shippingTax: 1 }), 25_000),
    /STRIPE_SHIPPING_TOTAL_MISMATCH/,
  );
});

test("shipping validation rejects invalid server-derived product subtotals", () => {
  assert.throws(
    () => resolveCheckoutShipping(stripeSession(), -1),
    /INVALID_STRIPE_PRODUCTS_SUBTOTAL/,
  );
  assert.throws(
    () => resolveCheckoutShipping(stripeSession(), 25_000.5),
    /INVALID_STRIPE_PRODUCTS_SUBTOTAL/,
  );
  assert.throws(
    () => resolveCheckoutShipping(stripeSession(), Number.NaN),
    /INVALID_STRIPE_PRODUCTS_SUBTOTAL/,
  );
});

test("shipping order persistence remains idempotent", async () => {
  const db = new DatabaseAdapter();
  const input = order({
    productsSubtotal: 25_000,
    shippingAmount: 1_000,
    shippingCountry: "FR",
    shippingZone: "FR",
  });
  assert.equal((await persistPaidOrder(db, input)).status, "created");
  assert.equal((await persistPaidOrder(db, input)).status, "already_exists");
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM orders").get()?.count, 1);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM order_lines").get()?.count, 1);
});

test("persistence refuses a shipping total that does not match product lines", async () => {
  const db = new DatabaseAdapter();
  const input = order({
    productsSubtotal: 24_000,
    shippingAmount: 1_000,
    shippingCountry: "FR",
    shippingZone: "FR",
  });
  await assert.rejects(
    persistPaidOrder(db, input),
    (error) => getOrderPersistenceErrorDetails(error).code === "INVALID_ORDER_PERSISTENCE_INPUT",
  );
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM orders").get()?.count, 0);
});

test("checkout.session.completed forwards only normalized shipping into order persistence", () => {
  const source = readFileSync("app/services/stripe-events.ts", "utf8");
  const checkoutHandlerMarker = "async function createPennylaneInvoice(";
  const nextHandlerMarker = "async function createPennylaneCreditNote(";
  assert.equal(source.split(checkoutHandlerMarker).length, 2);
  assert.equal(source.split(nextHandlerMarker).length, 2);
  const checkoutHandlerStart = source.indexOf(checkoutHandlerMarker);
  const checkoutHandlerEnd = source.indexOf(nextHandlerMarker, checkoutHandlerStart);
  assert.ok(checkoutHandlerStart >= 0 && checkoutHandlerEnd > checkoutHandlerStart);
  const checkoutHandler = source.slice(checkoutHandlerStart, checkoutHandlerEnd);

  assert.match(
    source,
    /case "checkout\.session\.completed":[\s\S]*createPennylaneInvoice\(\s*stripe,\s*session,/,
  );
  assert.match(
    checkoutHandler,
    /persistPaidOrder\(db, \{[\s\S]*?amountTotal: result\.amount,[\s\S]*?shipping: result\.shipping,/,
  );
  assert.doesNotMatch(
    checkoutHandler,
    /getRefundShippingContext|shippingRefundAmount|shipping_refund_amount|refundOperation/,
  );
});
