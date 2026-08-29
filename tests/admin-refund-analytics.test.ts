import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import test from "node:test";
import {
  AdminSalesAnalyticsQueryError,
  queryAdminSalesAnalytics,
} from "../app/services/admin-sales-analytics";
import {
  createAdminRefundAnalyticsGetHandler,
  parseAdminRefundAnalyticsSearchParams,
  queryAdminRefundAnalytics,
} from "../app/services/admin-refund-analytics";
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

type SeedLine = {
  orderLineId: string;
  catalogId: string;
  quantity: number;
  unitAmount: number;
};

function applyCurrentRefundSchema(sqlite: DatabaseSync) {
  for (const migration of [
    "0001_create_orders.sql",
    "0002_create_refund_operations.sql",
    "0003_track_refund_credit_notes.sql",
    "0006_harden_refund_operations.sql",
    "0007_create_multi_line_refund_operations.sql",
  ]) {
    sqlite.exec(readFileSync(`migrations/${migration}`, "utf8"));
  }
}

function insertOrder(
  sqlite: DatabaseSync,
  orderId: string,
  createdAt: string,
  lines: SeedLine[],
) {
  const amount = lines.reduce((sum, line) => sum + line.quantity * line.unitAmount, 0);
  sqlite.prepare(
    `INSERT INTO orders (
      id, stripe_checkout_session_id, stripe_payment_intent_id, pennylane_invoice_id,
      customer_email, currency, amount_total, status, schema_version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'analytics@example.test', 'eur', ?, 'paid', 1, ?, ?)`,
  ).run(orderId, `cs_test_${orderId}`, `pi_${orderId}`, `invoice-${orderId}`, amount, createdAt, createdAt);

  for (const [index, line] of lines.entries()) {
    sqlite.prepare(
      `INSERT INTO order_lines (
        id, order_id, order_line_id, stripe_line_item_id, pennylane_invoice_line_id,
        catalog_id, size_fr, quantity, unit_amount, refunded_quantity,
        reserved_refund_quantity, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 48, ?, ?, 0, 0, ?, ?)`,
    ).run(
      `${orderId}-line-${index}`,
      orderId,
      line.orderLineId,
      `li_${orderId}_${index}`,
      `invoice-line-${orderId}-${index}`,
      line.catalogId,
      line.quantity,
      line.unitAmount,
      createdAt,
      createdAt,
    );
  }
}

function currentRefundedQuantity(sqlite: DatabaseSync, orderLineId: string) {
  const row = sqlite.prepare(
    "SELECT refunded_quantity FROM order_lines WHERE order_line_id = ?",
  ).get(orderLineId) as { refunded_quantity: number } | undefined;
  assert.ok(row);
  return row.refunded_quantity;
}

function insertRefundOperation(
  sqlite: DatabaseSync,
  input: {
    id: string;
    orderId: string;
    createdAt: string;
    status: "pending" | "succeeded" | "failed";
    lines: Array<{ orderLineId: string; quantity: number; unitAmount: number }>;
  },
) {
  const amount = input.lines.reduce((sum, line) => sum + line.quantity * line.unitAmount, 0);
  sqlite.prepare(
    `INSERT INTO refund_operations (
      id, order_id, amount, currency, stripe_idempotency_key, stripe_refund_id,
      status, failure_code, created_at, updated_at
    ) VALUES (?, ?, ?, 'eur', ?, NULL, 'pending', NULL, ?, ?)`,
  ).run(input.id, input.orderId, amount, `idempotency-${input.id}`, input.createdAt, input.createdAt);

  for (const [index, line] of input.lines.entries()) {
    const refundedBefore = currentRefundedQuantity(sqlite, line.orderLineId);
    sqlite.prepare(
      `INSERT INTO refund_operation_lines (
        id, refund_operation_id, order_line_id, requested_quantity,
        refunded_quantity_before, unit_amount, amount, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `${input.id}-line-${index}`,
      input.id,
      line.orderLineId,
      line.quantity,
      refundedBefore,
      line.unitAmount,
      line.quantity * line.unitAmount,
      input.createdAt,
      input.createdAt,
    );
  }

  if (input.status === "succeeded") {
    sqlite.prepare(
      "UPDATE refund_operations SET stripe_refund_id = ?, status = 'succeeded', updated_at = ? WHERE id = ?",
    ).run(`re_${input.id}`, input.createdAt, input.id);
  } else if (input.status === "failed") {
    sqlite.prepare(
      "UPDATE refund_operations SET stripe_refund_id = ?, status = 'failed', failure_code = 'TEST_FAILURE', updated_at = ? WHERE id = ?",
    ).run(`re_${input.id}`, input.createdAt, input.id);
  }
}

function refundAnalyticsDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  applyCurrentRefundSchema(sqlite);

  insertOrder(sqlite, "order_august", "2026-08-10T10:00:00.000Z", [
    { orderLineId: "aug-geometry", catalogId: "geometry", quantity: 5, unitAmount: 25_000 },
    { orderLineId: "aug-hollow", catalogId: "hollow-cross", quantity: 3, unitAmount: 20_000 },
    { orderLineId: "aug-signet", catalogId: "signet-corner", quantity: 2, unitAmount: 15_000 },
    { orderLineId: "aug-damaged", catalogId: "damaged-ring-i", quantity: 1, unitAmount: 15_000 },
  ]);
  insertOrder(sqlite, "order_august_edge", "2026-08-31T21:30:00.000Z", [
    { orderLineId: "aug-edge-geometry", catalogId: "geometry", quantity: 1, unitAmount: 25_000 },
  ]);
  insertOrder(sqlite, "order_september_edge", "2026-08-31T22:30:00.000Z", [
    { orderLineId: "sep-geometry", catalogId: "geometry", quantity: 2, unitAmount: 25_000 },
  ]);
  insertOrder(sqlite, "order_july", "2026-07-15T10:00:00.000Z", [
    { orderLineId: "july-geometry", catalogId: "geometry", quantity: 1, unitAmount: 25_000 },
  ]);

  insertRefundOperation(sqlite, {
    id: "refund_aug_first", orderId: "order_august", createdAt: "2026-09-05T10:00:00.000Z",
    status: "succeeded", lines: [{ orderLineId: "aug-geometry", quantity: 1, unitAmount: 25_000 }],
  });
  insertRefundOperation(sqlite, {
    id: "refund_aug_failed", orderId: "order_august", createdAt: "2026-09-06T10:00:00.000Z",
    status: "failed", lines: [{ orderLineId: "aug-geometry", quantity: 1, unitAmount: 25_000 }],
  });
  insertRefundOperation(sqlite, {
    id: "refund_aug_second", orderId: "order_august", createdAt: "2026-09-07T10:00:00.000Z",
    status: "succeeded", lines: [{ orderLineId: "aug-geometry", quantity: 2, unitAmount: 25_000 }],
  });
  insertRefundOperation(sqlite, {
    id: "refund_aug_multi", orderId: "order_august", createdAt: "2026-09-08T10:00:00.000Z",
    status: "succeeded",
    lines: [
      { orderLineId: "aug-hollow", quantity: 1, unitAmount: 20_000 },
      { orderLineId: "aug-signet", quantity: 2, unitAmount: 15_000 },
    ],
  });
  insertRefundOperation(sqlite, {
    id: "refund_aug_pending", orderId: "order_august", createdAt: "2026-09-09T10:00:00.000Z",
    status: "pending", lines: [{ orderLineId: "aug-geometry", quantity: 1, unitAmount: 25_000 }],
  });
  insertRefundOperation(sqlite, {
    id: "refund_september", orderId: "order_september_edge", createdAt: "2026-09-10T10:00:00.000Z",
    status: "succeeded", lines: [{ orderLineId: "sep-geometry", quantity: 1, unitAmount: 25_000 }],
  });
  insertRefundOperation(sqlite, {
    id: "refund_july_in_august", orderId: "order_july", createdAt: "2026-08-05T10:00:00.000Z",
    status: "succeeded", lines: [{ orderLineId: "july-geometry", quantity: 1, unitAmount: 25_000 }],
  });

  return new SQLiteDatabaseAdapter(sqlite);
}

function parsed(query = "") {
  return parseAdminRefundAnalyticsSearchParams(new URLSearchParams(query));
}

test("refund analytics rejects unauthenticated access before reading D1", async () => {
  let databaseRead = false;
  const handler = createAdminRefundAnalyticsGetHandler({
    verifyAccess: async () => ({ ok: false }),
    getDatabase: () => {
      databaseRead = true;
      return refundAnalyticsDatabase();
    },
  });
  const response = await handler(new Request("https://example.test/api/admin/analytics/refunds"));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { ok: false, error: "UNAUTHORIZED" });
  assert.equal(databaseRead, false);
});

test("all-time cohort aggregation counts only succeeded operation lines without duplicating sales", async () => {
  const result = await queryAdminRefundAnalytics(refundAnalyticsDatabase(), parsed());
  const geometry = result.products.find((product) => product.catalog_id === "geometry");
  assert.deepEqual(geometry, {
    catalog_id: "geometry", name: "Geometry", quantity_refunded: 5,
    refunded_amount: 125_000, quantity_sold: 9, refund_rate: 5 / 9,
  });
  const noRefund = result.products.find((product) => product.catalog_id === "damaged-ring-i");
  assert.deepEqual(noRefund, {
    catalog_id: "damaged-ring-i", name: "Damaged Ring I", quantity_refunded: 0,
    refunded_amount: 0, quantity_sold: 1, refund_rate: 0,
  });
});

test("August cohort includes later refunds and excludes August refunds of July sales", async () => {
  const result = await queryAdminRefundAnalytics(refundAnalyticsDatabase(), parsed("month=2026-08"));
  const geometry = result.products.find((product) => product.catalog_id === "geometry");
  assert.deepEqual(geometry, {
    catalog_id: "geometry", name: "Geometry", quantity_refunded: 3,
    refunded_amount: 75_000, quantity_sold: 6, refund_rate: 0.5,
  });
  assert.equal(result.products.find((product) => product.catalog_id === "hollow-cross")?.quantity_refunded, 1);
  assert.equal(result.products.find((product) => product.catalog_id === "signet-corner")?.quantity_refunded, 2);
  assert.deepEqual(result.totals, {
    quantity_refunded: 6, refunded_amount: 125_000, quantity_sold: 12, refund_rate: 0.5,
  });
});

test("multi-item, partial, quantity greater than one and successive refunds aggregate once", async () => {
  const result = await queryAdminRefundAnalytics(refundAnalyticsDatabase(), parsed("month=2026-08"));
  const hollow = result.products.find((product) => product.catalog_id === "hollow-cross");
  const signet = result.products.find((product) => product.catalog_id === "signet-corner");
  assert.equal(hollow?.quantity_refunded, 1);
  assert.equal(hollow?.refunded_amount, 20_000);
  assert.equal(hollow?.refund_rate, 1 / 3);
  assert.equal(signet?.quantity_refunded, 2);
  assert.equal(signet?.refunded_amount, 30_000);
  assert.equal(signet?.refund_rate, 1);
});

test("pending and failed operations are ignored even when their quantities are reserved or released", async () => {
  const db = refundAnalyticsDatabase();
  const result = await queryAdminRefundAnalytics(db, parsed("month=2026-08"));
  assert.equal(result.products.find((product) => product.catalog_id === "geometry")?.quantity_refunded, 3);
  const pending = db.sqlite.prepare(
    "SELECT COUNT(*) AS count FROM refund_operations WHERE status = 'pending'",
  ).get() as { count: number };
  const failed = db.sqlite.prepare(
    "SELECT COUNT(*) AS count FROM refund_operations WHERE status = 'failed'",
  ).get() as { count: number };
  assert.equal(pending.count, 1);
  assert.equal(failed.count, 1);
});

test("the total refund rate is computed from totals rather than averaging product rates", async () => {
  const result = await queryAdminRefundAnalytics(refundAnalyticsDatabase(), parsed("month=2026-08"));
  const average = result.products.reduce((sum, product) => sum + product.refund_rate, 0)
    / result.products.length;
  assert.equal(result.totals.refund_rate, 6 / 12);
  assert.notEqual(result.totals.refund_rate, average);
});

test("month and year periods use Paris cohort boundaries including the UTC midnight edge", async () => {
  const augustQuery = parsed("month=2026-08");
  assert.equal(augustQuery.createdAtFrom, "2026-07-31T22:00:00.000Z");
  assert.equal(augustQuery.createdAtToExclusive, "2026-08-31T22:00:00.000Z");
  const august = await queryAdminRefundAnalytics(refundAnalyticsDatabase(), augustQuery);
  assert.equal(august.products.find((product) => product.catalog_id === "geometry")?.quantity_sold, 6);

  const september = await queryAdminRefundAnalytics(refundAnalyticsDatabase(), parsed("month=2026-09"));
  assert.equal(september.products.find((product) => product.catalog_id === "geometry")?.quantity_sold, 2);
  assert.equal(september.products.find((product) => product.catalog_id === "geometry")?.quantity_refunded, 1);

  const year = await queryAdminRefundAnalytics(refundAnalyticsDatabase(), parsed("year=2026"));
  assert.equal(year.totals.quantity_sold, 15);
  assert.equal(year.totals.quantity_refunded, 8);
});

test("refund analytics rejects conflicting, duplicate, unknown and malformed period parameters", () => {
  for (const query of [
    "month=2026-08&year=2026",
    "month=2026-13",
    "year=20A6",
    "month=2026-08&month=2026-09",
    "unknown=value",
  ]) {
    assert.throws(
      () => parsed(query),
      (error) => error instanceof AdminSalesAnalyticsQueryError,
    );
  }
});

test("sales and refund analytics keep cohort quantities and amounts coherent", async () => {
  for (const queryString of ["", "month=2026-08", "year=2026"]) {
    const db = refundAnalyticsDatabase();
    const query = parsed(queryString);
    const sales = await queryAdminSalesAnalytics(db, query);
    const refunds = await queryAdminRefundAnalytics(db, query);
    const salesByCatalog = new Map(sales.products.map((product) => [product.catalog_id, product]));

    for (const product of refunds.products) {
      const sale = salesByCatalog.get(product.catalog_id);
      assert.ok(sale, `missing sales row for ${product.catalog_id}`);
      assert.equal(product.quantity_sold, sale.quantity_sold);
      assert.ok(product.quantity_refunded <= product.quantity_sold);
      assert.ok(product.refunded_amount <= sale.gross_revenue);
    }

    assert.equal(refunds.totals.quantity_sold, sales.totals.quantity_sold);
    assert.ok(refunds.totals.quantity_refunded <= refunds.totals.quantity_sold);
    assert.ok(refunds.totals.refunded_amount <= sales.totals.gross_revenue);
  }
});
