import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import test from "node:test";
import { formatAdminDateTime } from "../app/services/admin-date";
import { buildOrdersSearchParams, type OrdersBrowserFilters } from "../app/admin/orders-filter-params";
import {
  AdminOrdersQueryError,
  createAdminOrdersGetHandler,
  parseAdminOrdersSearchParams,
  queryAdminOrders,
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
  },
];

function adminOrdersDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync("migrations/0001_create_orders.sql", "utf8"));
  sqlite.exec(readFileSync("migrations/0002_create_refund_operations.sql", "utf8"));
  sqlite.exec(readFileSync("migrations/0008_add_order_customer_name.sql", "utf8"));

  for (const [index, order] of SEED_ORDERS.entries()) {
    const suffix = String(index + 1).padStart(8, "0");
    sqlite.prepare(
      `INSERT INTO orders (
        id, stripe_checkout_session_id, stripe_payment_intent_id,
        pennylane_invoice_id, customer_name, customer_email, currency, amount_total,
        status, schema_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'eur', ?, 'paid', 1, ?, ?)`,
    ).run(
      order.id,
      `cs_test_admin${suffix}`,
      `pi_admin${suffix}`,
      `invoice-admin-${suffix}`,
      order.customerName,
      order.email,
      order.amount,
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
  const handler = createAdminOrdersGetHandler({
    verifyAccess: async () => ({ ok: false }),
    getDatabase: () => {
      databaseRead = true;
      return adminOrdersDatabase();
    },
  });
  const response = await handler(new Request("https://example.test/api/admin/orders"));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { ok: false, error: "UNAUTHORIZED" });
  assert.equal(databaseRead, false);
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
  assert.deepEqual(result.orders.map((order) => order.amount_total), [20_000, 25_000, 40_000]);
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
