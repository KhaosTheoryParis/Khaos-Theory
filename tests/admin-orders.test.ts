import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import test from "node:test";
import { formatAdminDateTime } from "../app/services/admin-date";
import {
  buildOrdersSearchParams,
  buildOrdersTableSearchParams,
  nextOrdersTableSort,
  type OrdersBrowserFilters,
} from "../app/admin/orders-filter-params";
import {
  AdminOrdersQueryError,
  createAdminOrdersGetHandler,
  parseAdminOrderDetailSearchParams,
  parseAdminOrdersSearchParams,
  projectAdminShippingAddress,
  queryAdminOrderDetail,
  queryAdminOrders,
  type AdminStripeCheckoutSession,
} from "../app/services/admin-orders";
import type { OrdersDatabase, OrdersPreparedStatement } from "../app/services/orders";

class SQLiteStatementAdapter implements OrdersPreparedStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: Array<string | number | null> = [],
  ) {}

  bind(...values: Array<string | number | null>) {
    return new SQLiteStatementAdapter(this.statement, values);
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

class SQLiteDatabaseAdapter implements OrdersDatabase {
  constructor(readonly sqlite: DatabaseSync) {}

  prepare(query: string) {
    return new SQLiteStatementAdapter(this.sqlite.prepare(query));
  }

  async batch(statements: OrdersPreparedStatement[]) {
    const results = [];
    for (const statement of statements) {
      const result = await statement.run();
      results.push({ success: result.success });
    }
    return results;
  }
}

type SeedOrder = {
  id: string;
  email: string;
  customerName: string | null;
  date: string;
  amount: number;
  product: string;
  size: number;
  quantity: number;
  refunded: number;
  reserved?: number;
  shipping: number;
};

const SEED_ORDERS: SeedOrder[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    email: "alice@example.test",
    customerName: "Vincent Gerard",
    date: "2026-08-10T10:00:00.000Z",
    amount: 25_000,
    product: "geometry",
    size: 48,
    quantity: 1,
    refunded: 0,
    shipping: 1_000,
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    email: "bob@example.test",
    customerName: "Alice Martin",
    date: "2026-08-20T10:00:00.000Z",
    amount: 40_000,
    product: "hollow-cross",
    size: 58,
    quantity: 2,
    refunded: 1,
    shipping: 0,
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    email: "carol@example.test",
    customerName: null,
    date: "2026-09-01T10:00:00.000Z",
    amount: 20_000,
    product: "carved-cross",
    size: 48,
    quantity: 1,
    refunded: 1,
    shipping: 0,
  },
];

function adminOrdersDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  for (const migration of [
    "migrations/0001_create_orders.sql",
    "migrations/0002_create_refund_operations.sql",
    "migrations/0003_track_refund_credit_notes.sql",
    "migrations/0006_harden_refund_operations.sql",
    "migrations/0007_create_multi_line_refund_operations.sql",
    "migrations/0008_add_order_customer_name.sql",
    "migrations/0009_add_shipping_to_orders.sql",
    "migrations/0010_add_shipping_refunds.sql",
  ]) sqlite.exec(readFileSync(migration, "utf8"));

  for (const [index, order] of SEED_ORDERS.entries()) {
    const suffix = String(index + 1).padStart(8, "0");
    sqlite.prepare(
      `INSERT INTO orders (
        id, stripe_checkout_session_id, stripe_payment_intent_id,
        pennylane_invoice_id, customer_name, customer_email, currency, amount_total,
        products_subtotal, shipping_amount, shipping_country, shipping_zone,
        shipping_refunded_amount, reserved_shipping_refund_amount,
        status, schema_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'eur', ?, ?, ?, 'FR', 'FR', 0, 0, 'paid', 1, ?, ?)`,
    ).run(
      order.id,
      `cs_test_admin${suffix}`,
      `pi_admin${suffix}`,
      `invoice-admin-${suffix}`,
      order.customerName,
      order.email,
      order.amount + order.shipping,
      order.amount,
      order.shipping,
      order.date,
      order.date,
    );
    sqlite.prepare(
      `INSERT INTO order_lines (
        id, order_id, order_line_id, stripe_line_item_id,
        pennylane_invoice_line_id, catalog_id, size_fr, quantity,
        unit_amount, refunded_quantity, reserved_refund_quantity,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `aaaaaaaa-aaaa-4aaa-8aaa-${suffix.padStart(12, "0")}`,
      order.id,
      `bbbbbbbb-bbbb-4bbb-8bbb-${suffix.padStart(12, "0")}`,
      `li_admin${suffix}`,
      `invoice-line-admin-${suffix}`,
      order.product,
      order.size,
      order.quantity,
      order.amount / order.quantity,
      order.refunded,
      order.reserved ?? 0,
      order.date,
      order.date,
    );
  }

  return new SQLiteDatabaseAdapter(sqlite);
}

function parsed(query = "") {
  return parseAdminOrdersSearchParams(new URLSearchParams(query));
}

const EMPTY_BROWSER_FILTERS: OrdersBrowserFilters = {
  query: "", name: "", dateFrom: "", dateTo: "", product: "", size: "", amountEuros: "",
  paymentStatus: "", refundStatus: "", sort: "created_at", direction: "desc",
};

function addAugust28Order(db: SQLiteDatabaseAdapter) {
  const id = "44444444-4444-4444-8444-444444444444";
  const createdAt = "2026-08-28T18:57:11.000Z";
  db.sqlite.prepare(
    `INSERT INTO orders (
      id, stripe_checkout_session_id, stripe_payment_intent_id, pennylane_invoice_id,
      customer_name, customer_email, currency, amount_total, status, schema_version, created_at, updated_at
    ) VALUES (?, 'cs_test_date_control', 'pi_date_control', 'invoice-date-control', NULL,
      'date-control@example.test', 'eur', 25000, 'paid', 1, ?, ?)`,
  ).run(id, createdAt, createdAt);
  db.sqlite.prepare(
    `INSERT INTO order_lines (
      id, order_id, order_line_id, stripe_line_item_id, pennylane_invoice_line_id,
      catalog_id, size_fr, quantity, unit_amount, refunded_quantity, reserved_refund_quantity, created_at, updated_at
    ) VALUES ('date-control-line', ?, 'date-control-order-line', 'li_date_control', 'invoice-line-date-control',
      'geometry', 48, 1, 25000, 0, 0, ?, ?)`,
  ).run(id, createdAt, createdAt);
  return id;
}

test("the admin orders endpoint rejects an unauthenticated request", async () => {
  let databaseRead = false;
  let stripeRead = false;
  const handler = createAdminOrdersGetHandler({
    verifyAccess: async () => ({ ok: false }),
    getDatabase: () => {
      databaseRead = true;
      return adminOrdersDatabase();
    },
    retrieveCheckoutSession: async () => {
      stripeRead = true;
      return { id: "cs_test_never_read" };
    },
  });
  const response = await handler(new Request("https://example.test/api/admin/orders"));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { ok: false, error: "UNAUTHORIZED" });
  assert.equal(databaseRead, false);
  assert.equal(stripeRead, false);
});

test("admin orders pagination defaults to 25 and applies server-side pages", async () => {
  const db = adminOrdersDatabase();
  assert.equal(parsed().pageSize, 25);
  const page = await queryAdminOrders(db, parsed("page=2&page_size=2&sort=created_at&direction=asc"));
  assert.equal(page.pagination.total, 3);
  assert.equal(page.pagination.total_pages, 2);
  assert.equal(page.orders.length, 1);
  assert.equal(page.orders[0]?.customer_email, "carol@example.test");
});

test("the Commandes table sends one server search and cycles sortable columns", () => {
  const params = buildOrdersTableSearchParams(
    "  Geometry  ",
    2,
    { column: "product", direction: "asc" },
  );
  assert.equal(params.toString(), "page=2&page_size=25&sort=product&direction=asc&q=Geometry");
  assert.deepEqual(
    nextOrdersTableSort({ column: "created_at", direction: "desc" }, "customer_name"),
    { column: "customer_name", direction: "asc" },
  );
  assert.deepEqual(
    nextOrdersTableSort({ column: "customer_name", direction: "asc" }, "customer_name"),
    { column: "customer_name", direction: "desc" },
  );
});

test("global search finds an email and an order ID", async () => {
  const db = adminOrdersDatabase();
  const email = await queryAdminOrders(db, parsed("q=ALICE%40EXAMPLE.TEST"));
  assert.deepEqual(email.orders.map((order) => order.id), [SEED_ORDERS[0]?.id]);

  const orderId = await queryAdminOrders(db, parsed(`q=${SEED_ORDERS[1]?.id}`));
  assert.deepEqual(orderId.orders.map((order) => order.id), [SEED_ORDERS[1]?.id]);

  const checkout = await queryAdminOrders(db, parsed("q=cs_test_admin00000003"));
  assert.deepEqual(checkout.orders.map((order) => order.id), [SEED_ORDERS[2]?.id]);

  const paymentIntent = await queryAdminOrders(db, parsed("q=pi_admin00000001"));
  assert.deepEqual(paymentIntent.orders.map((order) => order.id), [SEED_ORDERS[0]?.id]);

  const customerName = await queryAdminOrders(db, parsed("q=vincent"));
  assert.deepEqual(customerName.orders.map((order) => order.id), [SEED_ORDERS[0]?.id]);

  const productName = await queryAdminOrders(db, parsed("q=Hollow%20Kross"));
  assert.deepEqual(productName.orders.map((order) => order.id), [SEED_ORDERS[1]?.id]);

  const productReference = await queryAdminOrders(db, parsed("q=geometry"));
  assert.deepEqual(productReference.orders.map((order) => order.id), [SEED_ORDERS[0]?.id]);

  const invoice = await queryAdminOrders(db, parsed("q=invoice-admin-00000002"));
  assert.deepEqual(invoice.orders.map((order) => order.id), [SEED_ORDERS[1]?.id]);
});

test("a strict detail lookup returns operational and refundable D1 fields", async () => {
  const db = adminOrdersDatabase();
  const orderId = SEED_ORDERS[0]?.id ?? "";
  assert.equal(parseAdminOrderDetailSearchParams(new URLSearchParams(`order_id=${orderId}`)), orderId);
  assert.throws(
    () => parseAdminOrderDetailSearchParams(new URLSearchParams(`order_id=${orderId}&page=1`)),
    (error) => error instanceof AdminOrdersQueryError && error.code === "CONFLICTING_DETAIL_PARAMETERS",
  );

  const detail = await queryAdminOrderDetail(db, orderId);
  assert.ok(detail);
  assert.equal(detail.customer_name, "Vincent Gerard");
  assert.equal(detail.stripe_payment_intent_id, "pi_admin00000001");
  assert.equal(detail.stripe_checkout_session_id, "cs_test_admin00000001");
  assert.equal(detail.pennylane_invoice_id, "invoice-admin-00000001");
  assert.equal(detail.products_subtotal, 25_000);
  assert.equal(detail.shipping?.amount, 1_000);
  assert.equal(detail.shipping?.refundable_amount, 1_000);
  assert.equal(detail.shipping_address, null);
  assert.equal(detail.amount_total, 26_000);
  assert.equal(detail.lines[0]?.refundable_quantity, 1);
  assert.equal(detail.remaining_refundable_amount, 26_000);
});

test("the Stripe shipping projection exposes only the complete Admin address and supports no line2", () => {
  const sessionId = "cs_test_admin00000001";
  const complete = projectAdminShippingAddress({
    id: sessionId,
    collected_information: {
      shipping_details: {
        name: "Ada Lovelace",
        address: {
          line1: "10 rue de Test",
          line2: "Bâtiment B",
          postal_code: "75001",
          city: "Paris",
          country: "FR",
        },
      },
    },
  }, sessionId);
  assert.deepEqual(complete, {
    name: "Ada Lovelace",
    line1: "10 rue de Test",
    line2: "Bâtiment B",
    postal_code: "75001",
    city: "Paris",
    country: "FR",
  });
  assert.deepEqual(Object.keys(complete ?? {}).sort(), [
    "city", "country", "line1", "line2", "name", "postal_code",
  ]);

  const withoutLine2 = projectAdminShippingAddress({
    id: sessionId,
    collected_information: {
      shipping_details: {
        name: "Ada Lovelace",
        address: { line1: "10 rue de Test", postal_code: "75001", city: "Paris", country: "FR" },
      },
    },
  }, sessionId);
  assert.equal(withoutLine2?.line2, null);
});

test("the Stripe shipping projection returns no invented address when Stripe data is absent or mismatched", () => {
  const sessionId = "cs_test_admin00000001";
  assert.equal(projectAdminShippingAddress({ id: sessionId }, sessionId), null);
  assert.equal(projectAdminShippingAddress({
    id: sessionId,
    collected_information: { shipping_details: { address: { country: "FR" } } },
  }, sessionId), null);
  assert.equal(projectAdminShippingAddress({
    id: "cs_test_another",
    collected_information: {
      shipping_details: {
        address: { line1: "10 rue de Test", postal_code: "75001", city: "Paris", country: "FR" },
      },
    },
  }, sessionId), null);
});

test("the protected Admin endpoint serves one strict order detail without listing history", async () => {
  let stripeReads = 0;
  const stripeSession = {
    id: "cs_test_admin00000001",
    collected_information: {
      shipping_details: {
        name: "Ada Lovelace",
        address: {
          line1: "10 rue de Test",
          postal_code: "75001",
          city: "Paris",
          country: "FR",
        },
      },
    },
    client_secret: "must-never-reach-the-admin-response",
    metadata: { private_marker: "must-never-reach-the-admin-response" },
  } as AdminStripeCheckoutSession & {
    client_secret: string;
    metadata: { private_marker: string };
  };
  const handler = createAdminOrdersGetHandler({
    verifyAccess: async () => ({ ok: true }),
    getDatabase: () => adminOrdersDatabase(),
    retrieveCheckoutSession: async () => {
      stripeReads += 1;
      return stripeSession;
    },
  });
  const orderId = SEED_ORDERS[0]?.id ?? "";
  const response = await handler(new Request(
    `https://example.test/api/admin/orders?order_id=${orderId}`,
  ));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const body = await response.json() as {
    ok: boolean;
    order: { id: string; lines: unknown[]; shipping_address: unknown };
  };
  assert.equal(body.ok, true);
  assert.equal(body.order.id, orderId);
  assert.equal(body.order.lines.length, 1);
  assert.deepEqual(body.order.shipping_address, {
    name: "Ada Lovelace",
    line1: "10 rue de Test",
    line2: null,
    postal_code: "75001",
    city: "Paris",
    country: "FR",
  });
  assert.equal(JSON.stringify(body).includes("must-never-reach-the-admin-response"), false);
  assert.equal(stripeReads, 1);

  const missing = await handler(new Request(
    "https://example.test/api/admin/orders?order_id=99999999-9999-4999-8999-999999999999",
  ));
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { ok: false, error: "ORDER_NOT_FOUND" });
  assert.equal(stripeReads, 1);

  const list = await handler(new Request("https://example.test/api/admin/orders?page=1"));
  assert.equal(list.status, 200);
  assert.equal(stripeReads, 1);
});

test("a failed Stripe address enrichment does not fail the protected D1 order detail", async () => {
  const handler = createAdminOrdersGetHandler({
    verifyAccess: async () => ({ ok: true }),
    getDatabase: () => adminOrdersDatabase(),
    retrieveCheckoutSession: async () => {
      throw new Error("STRIPE_UNAVAILABLE");
    },
  });
  const orderId = SEED_ORDERS[0]?.id ?? "";
  const response = await handler(new Request(
    `https://example.test/api/admin/orders?order_id=${orderId}`,
  ));
  assert.equal(response.status, 200);
  const body = await response.json() as { ok: boolean; order: { shipping_address: unknown } };
  assert.equal(body.ok, true);
  assert.equal(body.order.shipping_address, null);
});

test("the transaction detail renders the projected address and an explicit unavailable state", () => {
  const source = readFileSync("app/admin/orders-browser.tsx", "utf8");
  for (const field of ["name", "line1", "line2", "postal_code", "city", "country"]) {
    assert.match(source, new RegExp(`shipping_address\\.${field}`));
  }
  assert.match(source, /Adresse de livraison indisponible dans Stripe\./);
});

test("customer name search is partial, case-insensitive and NULL-compatible", async () => {
  const db = adminOrdersDatabase();
  const partial = await queryAdminOrders(db, parsed("name=GER"));
  assert.deepEqual(partial.orders.map((order) => order.id), [SEED_ORDERS[0]?.id]);
  assert.equal(partial.orders[0]?.customer_name, "Vincent Gerard");

  const historical = await queryAdminOrders(db, parsed(`q=${SEED_ORDERS[2]?.id}`));
  assert.equal(historical.orders[0]?.customer_name, null);
});

test("product and size filters apply to the same stored order line", async () => {
  const db = adminOrdersDatabase();
  const product = await queryAdminOrders(db, parsed("product=geometry"));
  assert.deepEqual(product.orders.map((order) => order.id), [SEED_ORDERS[0]?.id]);

  const size = await queryAdminOrders(db, parsed("size=58"));
  assert.deepEqual(size.orders.map((order) => order.id), [SEED_ORDERS[1]?.id]);

  const mismatch = await queryAdminOrders(db, parsed("product=geometry&size=58"));
  assert.equal(mismatch.orders.length, 0);
});

test("exact date and date ranges are applied on the server", async () => {
  const db = adminOrdersDatabase();
  const exact = await queryAdminOrders(db, parsed("date=2026-08-20"));
  assert.deepEqual(exact.orders.map((order) => order.id), [SEED_ORDERS[1]?.id]);

  const range = await queryAdminOrders(db, parsed("date_from=2026-08-01&date_to=2026-08-31"));
  assert.equal(range.orders.length, 2);
});

test("a populated native date control is forwarded as date_from/date_to and filters one Paris day", async () => {
  const db = adminOrdersDatabase();
  const expectedId = addAugust28Order(db);
  const nativeDateFrom = { value: "2026-08-28" };
  const nativeDateTo = { value: "2026-08-28" };

  assert.equal(nativeDateFrom.value, "2026-08-28");
  assert.equal(nativeDateTo.value, "2026-08-28");

  const params = buildOrdersSearchParams({
    ...EMPTY_BROWSER_FILTERS,
    dateFrom: nativeDateFrom.value,
    dateTo: nativeDateTo.value,
  }, 1);
  assert.equal(params.get("date_from"), nativeDateFrom.value);
  assert.equal(params.get("date_to"), nativeDateTo.value);

  const result = await queryAdminOrders(db, parseAdminOrdersSearchParams(params));
  assert.deepEqual(result.orders.map((order) => order.id), [expectedId]);
});

test("Paris calendar filters convert CET and CEST boundaries to UTC", () => {
  const winter = parsed("date=2026-01-15");
  assert.equal(winter.dateFrom, "2026-01-14T23:00:00.000Z");
  assert.equal(winter.dateToExclusive, "2026-01-15T23:00:00.000Z");

  const summer = parsed("date=2026-08-29");
  assert.equal(summer.dateFrom, "2026-08-28T22:00:00.000Z");
  assert.equal(summer.dateToExclusive, "2026-08-29T22:00:00.000Z");

  const springChange = parsed("date=2026-03-29");
  assert.equal(springChange.dateFrom, "2026-03-28T23:00:00.000Z");
  assert.equal(springChange.dateToExclusive, "2026-03-29T22:00:00.000Z");

  const autumnChange = parsed("date=2026-10-25");
  assert.equal(autumnChange.dateFrom, "2026-10-24T22:00:00.000Z");
  assert.equal(autumnChange.dateToExclusive, "2026-10-25T23:00:00.000Z");
});

test("admin timestamps are formatted explicitly in Europe/Paris", () => {
  assert.match(formatAdminDateTime("2026-08-29T12:00:00.000Z"), /14:00/);
  assert.match(formatAdminDateTime("2026-01-15T12:00:00.000Z"), /13:00/);
});

test("combined filters use AND semantics and derive refund status", async () => {
  const db = adminOrdersDatabase();
  const result = await queryAdminOrders(
    db,
    parsed("product=geometry&size=FR48&date_from=2026-08-01&date_to=2026-08-31&refund_status=none&status=paid"),
  );
  assert.equal(result.orders.length, 1);
  assert.equal(result.orders[0]?.refund_status, "none");

  const partial = await queryAdminOrders(db, parsed("refund_status=partial"));
  assert.deepEqual(partial.orders.map((order) => order.id), [SEED_ORDERS[1]?.id]);
  const full = await queryAdminOrders(db, parsed("refund_status=full"));
  assert.deepEqual(full.orders.map((order) => order.id), [SEED_ORDERS[2]?.id]);
});

test("an allowed sort is applied server-side", async () => {
  const db = adminOrdersDatabase();
  const result = await queryAdminOrders(db, parsed("sort=amount_total&direction=asc"));
  assert.deepEqual(result.orders.map((order) => order.amount_total), [20_000, 26_000, 40_000]);

  const byCustomer = await queryAdminOrders(db, parsed("sort=customer_name&direction=asc"));
  assert.deepEqual(byCustomer.orders.map((order) => order.customer_name), [
    null, "Alice Martin", "Vincent Gerard",
  ]);

  const byProduct = await queryAdminOrders(db, parsed("sort=product&direction=asc"));
  assert.deepEqual(byProduct.orders.map((order) => order.lines[0]?.product_name), [
    "Geometry", "Hollow Kross", "Karved Kross",
  ]);
});

test("amount and payment filters use the values stored in D1", async () => {
  const db = adminOrdersDatabase();
  const result = await queryAdminOrders(db, parsed("amount=40000&status=paid"));
  assert.deepEqual(result.orders.map((order) => order.id), [SEED_ORDERS[1]?.id]);
});

test("unapproved sorting and invalid parameters are rejected", () => {
  assert.throws(
    () => parsed("sort=stripe_payment_intent_id"),
    (error) => error instanceof AdminOrdersQueryError && error.code === "INVALID_SORT_COLUMN",
  );
  assert.throws(
    () => parsed("page_size=101"),
    (error) => error instanceof AdminOrdersQueryError && error.code === "INVALID_PAGE_SIZE",
  );
  assert.throws(
    () => parsed("date=2026-02-30"),
    (error) => error instanceof AdminOrdersQueryError && error.code === "INVALID_DATE_FILTER",
  );
  assert.throws(
    () => parsed("unexpected=value"),
    (error) => error instanceof AdminOrdersQueryError && error.code === "UNKNOWN_QUERY_PARAMETER",
  );
});

test("search input is bound as data and cannot inject SQL", async () => {
  const db = adminOrdersDatabase();
  const malicious = encodeURIComponent("%' OR 1=1 --");
  const result = await queryAdminOrders(db, parsed(`q=${malicious}`));
  assert.equal(result.orders.length, 0);
  const row = db.sqlite.prepare("SELECT COUNT(*) AS count FROM orders").get() as { count: number };
  assert.equal(row.count, 3);

  const nameInjection = await queryAdminOrders(db, parsed(`name=${malicious}`));
  assert.equal(nameInjection.orders.length, 0);
});
