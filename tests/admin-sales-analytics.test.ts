import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import test from "node:test";
import {
  AdminSalesAnalyticsQueryError,
  createAdminSalesAnalyticsGetHandler,
  parseAdminSalesAnalyticsSearchParams,
  queryAdminSalesAnalytics,
} from "../app/services/admin-sales-analytics";
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
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

type SeedSale = {
  id: string;
  catalogId: string;
  quantity: number;
  unitAmount: number;
  createdAt: string;
  status?: string;
  refundedQuantity?: number;
};

function salesDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync("migrations/0001_create_orders.sql", "utf8"));
  const sales: SeedSale[] = [
    {
      id: "11111111-1111-4111-8111-111111111111",
      catalogId: "geometry",
      quantity: 2,
      unitAmount: 25_000,
      createdAt: "2026-08-10T10:00:00.000Z",
      refundedQuantity: 2,
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      catalogId: "hollow-cross",
      quantity: 1,
      unitAmount: 20_000,
      createdAt: "2026-08-31T21:30:00.000Z",
    },
    {
      id: "33333333-3333-4333-8333-333333333333",
      catalogId: "geometry",
      quantity: 1,
      unitAmount: 25_000,
      createdAt: "2026-08-31T22:30:00.000Z",
    },
    {
      id: "44444444-4444-4444-8444-444444444444",
      catalogId: "signet-corner",
      quantity: 1,
      unitAmount: 20_000,
      createdAt: "2026-01-15T12:00:00.000Z",
    },
    {
      id: "55555555-5555-4555-8555-555555555555",
      catalogId: "geometry",
      quantity: 10,
      unitAmount: 25_000,
      createdAt: "2026-08-20T12:00:00.000Z",
      status: "unpaid",
    },
  ];

  for (const [index, sale] of sales.entries()) {
    const suffix = String(index + 1).padStart(8, "0");
    sqlite.prepare(
      `INSERT INTO orders (
        id, stripe_checkout_session_id, stripe_payment_intent_id, pennylane_invoice_id,
        customer_email, currency, amount_total, status, schema_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'analytics@example.test', 'eur', ?, ?, 1, ?, ?)`,
    ).run(
      sale.id,
      `cs_test_sales${suffix}`,
      `pi_sales${suffix}`,
      `invoice-sales-${suffix}`,
      sale.quantity * sale.unitAmount,
      sale.status ?? "paid",
      sale.createdAt,
      sale.createdAt,
    );
    sqlite.prepare(
      `INSERT INTO order_lines (
        id, order_id, order_line_id, stripe_line_item_id, pennylane_invoice_line_id,
        catalog_id, size_fr, quantity, unit_amount, refunded_quantity, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 48, ?, ?, ?, ?, ?)`,
    ).run(
      `aaaaaaaa-aaaa-4aaa-8aaa-${suffix.padStart(12, "0")}`,
      sale.id,
      `bbbbbbbb-bbbb-4bbb-8bbb-${suffix.padStart(12, "0")}`,
      `li_sales${suffix}`,
      `invoice-line-sales-${suffix}`,
      sale.catalogId,
      sale.quantity,
      sale.unitAmount,
      sale.refundedQuantity ?? 0,
      sale.createdAt,
      sale.createdAt,
    );
  }

  return new SQLiteDatabaseAdapter(sqlite);
}

function parsed(query = "") {
  return parseAdminSalesAnalyticsSearchParams(new URLSearchParams(query));
}

test("sales analytics rejects unauthenticated access before reading D1", async () => {
  let databaseRead = false;
  const handler = createAdminSalesAnalyticsGetHandler({
    verifyAccess: async () => ({ ok: false }),
    getDatabase: () => {
      databaseRead = true;
      return salesDatabase();
    },
  });

  const response = await handler(new Request("https://example.test/api/admin/analytics/sales"));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { ok: false, error: "UNAUTHORIZED" });
  assert.equal(databaseRead, false);
});

test("all-time sales aggregate paid order lines by product and quantity", async () => {
  const result = await queryAdminSalesAnalytics(salesDatabase(), parsed());
  assert.deepEqual(result.period, { kind: "all_time", value: null });
  assert.deepEqual(result.products, [
    { catalog_id: "geometry", product_name: "Geometry", quantity_sold: 3, gross_revenue: 75_000 },
    { catalog_id: "hollow-cross", product_name: "Hollow Kross", quantity_sold: 1, gross_revenue: 20_000 },
    { catalog_id: "signet-corner", product_name: "Signet Korner", quantity_sold: 1, gross_revenue: 20_000 },
  ]);
  assert.deepEqual(result.totals, { quantity_sold: 5, gross_revenue: 115_000 });
});

test("refunded quantities never reduce historical gross sales", async () => {
  const result = await queryAdminSalesAnalytics(salesDatabase(), parsed("month=2026-08"));
  assert.deepEqual(result.products, [
    { catalog_id: "geometry", product_name: "Geometry", quantity_sold: 2, gross_revenue: 50_000 },
    { catalog_id: "hollow-cross", product_name: "Hollow Kross", quantity_sold: 1, gross_revenue: 20_000 },
  ]);
  assert.deepEqual(result.totals, { quantity_sold: 3, gross_revenue: 70_000 });
});

test("month filters use Europe/Paris calendar boundaries at the UTC midnight edge", async () => {
  const august = parsed("month=2026-08");
  assert.equal(august.createdAtFrom, "2026-07-31T22:00:00.000Z");
  assert.equal(august.createdAtToExclusive, "2026-08-31T22:00:00.000Z");
  const augustResult = await queryAdminSalesAnalytics(salesDatabase(), august);
  assert.deepEqual(augustResult.totals, { quantity_sold: 3, gross_revenue: 70_000 });

  const septemberResult = await queryAdminSalesAnalytics(salesDatabase(), parsed("month=2026-09"));
  assert.deepEqual(septemberResult.products, [
    { catalog_id: "geometry", product_name: "Geometry", quantity_sold: 1, gross_revenue: 25_000 },
  ]);
});

test("year filters use Europe/Paris bounds and return only sales in that calendar year", async () => {
  const result = await queryAdminSalesAnalytics(salesDatabase(), parsed("year=2026"));
  assert.deepEqual(result.totals, { quantity_sold: 5, gross_revenue: 115_000 });
});

test("analytics period parameters are strictly exclusive and validated", () => {
  assert.throws(
    () => parsed("month=2026-08&year=2026"),
    (error) => error instanceof AdminSalesAnalyticsQueryError && error.code === "CONFLICTING_PERIOD_FILTERS",
  );
  assert.throws(
    () => parsed("month=2026-13"),
    (error) => error instanceof AdminSalesAnalyticsQueryError && error.code === "INVALID_MONTH_FILTER",
  );
  assert.throws(
    () => parsed("year=twenty26"),
    (error) => error instanceof AdminSalesAnalyticsQueryError && error.code === "INVALID_YEAR_FILTER",
  );
  assert.throws(
    () => parsed("month=2026-08&month=2026-09"),
    (error) => error instanceof AdminSalesAnalyticsQueryError && error.code === "DUPLICATE_QUERY_PARAMETER",
  );
  assert.throws(
    () => parsed("unexpected=value"),
    (error) => error instanceof AdminSalesAnalyticsQueryError && error.code === "UNKNOWN_QUERY_PARAMETER",
  );
});
