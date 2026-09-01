import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import test from "node:test";
import {
  failRefundOperation,
  finalizeRefundOperation,
  getRefundContext,
  getRefundPersistenceErrorDetails,
  reserveRefundOperationLines,
  reserveShippingRefundOperation,
} from "../app/services/refunds";
import type { OrdersDatabase, OrdersPreparedStatement } from "../app/services/orders";

const MIGRATIONS = [
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
] as const;

const TIMESTAMP = "2026-08-30T12:00:00.000Z";

function applyMigrations(sqlite: DatabaseSync, throughVersion: number = MIGRATIONS.length) {
  for (const migration of MIGRATIONS.slice(0, throughVersion)) {
    sqlite.exec(readFileSync(`migrations/${migration}`, "utf8"));
  }
}

function database(throughVersion: number = MIGRATIONS.length) {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite, throughVersion);
  return sqlite;
}

class ServiceStatementAdapter implements OrdersPreparedStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: Array<string | number | null> = [],
  ) {}

  bind(...values: Array<string | number | null>) {
    return new ServiceStatementAdapter(this.statement, values);
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

class ServiceDatabaseAdapter implements OrdersDatabase {
  constructor(readonly sqlite: DatabaseSync) {}

  prepare(query: string) {
    return new ServiceStatementAdapter(this.sqlite.prepare(query));
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

function identifier(prefix: string, suffix: number) {
  return `${prefix}-${String(suffix).padStart(12, "0")}`;
}

function insertHistoricalOrder(sqlite: DatabaseSync, suffix: number) {
  const orderId = identifier("11111111-1111-4111-8111", suffix);
  sqlite.prepare(
    `INSERT INTO orders (
      id, stripe_checkout_session_id, stripe_payment_intent_id, pennylane_invoice_id,
      customer_email, currency, amount_total, status, schema_version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'eur', 25000, 'paid', 1, ?, ?)`,
  ).run(
    orderId,
    `cs_test_historicalShippingRefund${suffix}`,
    `pi_historicalShippingRefund${suffix}`,
    `invoice-historical-shipping-refund-${suffix}`,
    `historical-shipping-refund-${suffix}@example.test`,
    TIMESTAMP,
    TIMESTAMP,
  );
  return orderId;
}

function insertShippingOrder(
  sqlite: DatabaseSync,
  suffix: number,
  shippingAmount: number | null,
) {
  const orderId = identifier("11111111-1111-4111-8111", suffix);
  sqlite.prepare(
    `INSERT INTO orders (
      id, stripe_checkout_session_id, stripe_payment_intent_id, pennylane_invoice_id,
      customer_email, currency, amount_total, status, schema_version, created_at, updated_at,
      products_subtotal, shipping_amount, shipping_country, shipping_zone
    ) VALUES (?, ?, ?, ?, ?, 'eur', ?, 'paid', 1, ?, ?, 25000, ?, ?, ?)`,
  ).run(
    orderId,
    `cs_test_shippingRefund${suffix}`,
    `pi_shippingRefund${suffix}`,
    `invoice-shipping-refund-${suffix}`,
    `shipping-refund-${suffix}@example.test`,
    25_000 + (shippingAmount ?? 0),
    TIMESTAMP,
    TIMESTAMP,
    shippingAmount,
    shippingAmount === null ? null : "FR",
    shippingAmount === null ? null : "FR",
  );
  return orderId;
}

function insertOrderLine(sqlite: DatabaseSync, orderId: string, suffix: number) {
  const orderLineId = identifier("22222222-2222-4222-8222", suffix);
  sqlite.prepare(
    `INSERT INTO order_lines (
      id, order_id, order_line_id, stripe_line_item_id, pennylane_invoice_line_id,
      catalog_id, size_fr, quantity, unit_amount, refunded_quantity,
      reserved_refund_quantity, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'geometry', 58, 1, 25000, 0, 0, ?, ?)`,
  ).run(
    identifier("33333333-3333-4333-8333", suffix),
    orderId,
    orderLineId,
    `li_shippingRefund${suffix}`,
    `invoice-line-shipping-refund-${suffix}`,
    TIMESTAMP,
    TIMESTAMP,
  );
  return orderLineId;
}

function insertRefundOperation(
  sqlite: DatabaseSync,
  orderId: string,
  suffix: number,
  amount: number,
  shippingRefundAmount: number | null,
) {
  const operationId = identifier("aaaaaaaa-aaaa-4aaa-8aaa", suffix);
  sqlite.prepare(
    `INSERT INTO refund_operations (
      id, order_id, amount, currency, stripe_idempotency_key, stripe_refund_id,
      status, failure_code, pennylane_credit_note_id, credit_note_status,
      created_at, updated_at, shipping_refund_amount
    ) VALUES (?, ?, ?, 'eur', ?, NULL, 'pending', NULL, NULL, 'pending', ?, ?, ?)`,
  ).run(
    operationId,
    orderId,
    amount,
    `khaos-shipping-refund-test:${suffix}`,
    TIMESTAMP,
    TIMESTAMP,
    shippingRefundAmount,
  );
  return operationId;
}

function insertLegacyRefundOperation(
  sqlite: DatabaseSync,
  orderId: string,
  suffix: number,
  amount: number,
) {
  const operationId = identifier("aaaaaaaa-aaaa-4aaa-8aaa", suffix);
  sqlite.prepare(
    `INSERT INTO refund_operations (
      id, order_id, amount, currency, stripe_idempotency_key, stripe_refund_id,
      status, failure_code, pennylane_credit_note_id, credit_note_status,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'eur', ?, NULL, 'pending', NULL, NULL, 'pending', ?, ?)`,
  ).run(
    operationId,
    orderId,
    amount,
    `khaos-legacy-refund-test:${suffix}`,
    TIMESTAMP,
    TIMESTAMP,
  );
  return operationId;
}

function insertRefundLine(
  sqlite: DatabaseSync,
  operationId: string,
  orderLineId: string,
  suffix: number,
) {
  sqlite.prepare(
    `INSERT INTO refund_operation_lines (
      id, refund_operation_id, order_line_id, requested_quantity,
      refunded_quantity_before, unit_amount, amount, created_at, updated_at
    ) VALUES (?, ?, ?, 1, 0, 25000, 25000, ?, ?)`,
  ).run(
    identifier("bbbbbbbb-bbbb-4bbb-8bbb", suffix),
    operationId,
    orderLineId,
    TIMESTAMP,
    TIMESTAMP,
  );
}

function shippingState(sqlite: DatabaseSync, orderId: string) {
  const row = sqlite.prepare(
    `SELECT shipping_amount, shipping_refunded_amount, reserved_shipping_refund_amount
     FROM orders WHERE id = ?`,
  ).get(orderId) as Record<string, number | null>;
  return {
    shipping_amount: row.shipping_amount,
    shipping_refunded_amount: row.shipping_refunded_amount,
    reserved_shipping_refund_amount: row.reserved_shipping_refund_amount,
  };
}

test("migrations 0001 through 0010 produce an intact schema with the shipping triggers", () => {
  const sqlite = database();
  assert.equal(sqlite.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
  assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);

  const orderColumns = sqlite.prepare("PRAGMA table_info(orders)").all() as Array<{
    name: string;
    notnull: number;
    dflt_value: string | number | null;
  }>;
  for (const name of [
    "products_subtotal",
    "shipping_amount",
    "shipping_country",
    "shipping_zone",
    "shipping_refunded_amount",
    "reserved_shipping_refund_amount",
  ]) {
    const column = orderColumns.find((candidate) => candidate.name === name);
    assert.deepEqual(
      column && { notnull: column.notnull, defaultValue: column.dflt_value },
      { notnull: 0, defaultValue: null },
    );
  }

  const refundColumns = sqlite.prepare("PRAGMA table_info(refund_operations)").all() as Array<{
    name: string;
    notnull: number;
    dflt_value: string | number | null;
  }>;
  const shippingRefundColumn = refundColumns.find(
    (candidate) => candidate.name === "shipping_refund_amount",
  );
  assert.deepEqual(
    shippingRefundColumn && {
      notnull: shippingRefundColumn.notnull,
      defaultValue: shippingRefundColumn.dflt_value,
    },
    { notnull: 0, defaultValue: null },
  );

  const refundTriggers = sqlite.prepare(
    `SELECT name FROM sqlite_master
     WHERE type = 'trigger' AND name LIKE 'refund_%'
     ORDER BY name`,
  ).all().map((row) => row.name);
  assert.deepEqual(refundTriggers, [
    "refund_operation_lines_reserve_quantity",
    "refund_operations_finalize_quantities",
    "refund_operations_release_failed_quantities",
    "refund_operations_reserve_shipping",
  ]);
});

test("migration 0010 preserves historical orders with NULL shipping state", () => {
  const sqlite = database(8);
  const orderId = insertHistoricalOrder(sqlite, 1);
  sqlite.exec(readFileSync("migrations/0009_add_shipping_to_orders.sql", "utf8"));
  sqlite.exec(readFileSync("migrations/0010_add_shipping_refunds.sql", "utf8"));

  assert.deepEqual(shippingState(sqlite, orderId), {
    shipping_amount: null,
    shipping_refunded_amount: null,
    reserved_shipping_refund_amount: null,
  });
});

test("free and paid shipping orders remain distinguishable", () => {
  const sqlite = database();
  const freeOrderId = insertShippingOrder(sqlite, 2, 0);
  const paidOrderId = insertShippingOrder(sqlite, 3, 1_000);
  assert.equal(shippingState(sqlite, freeOrderId).shipping_amount, 0);
  assert.equal(shippingState(sqlite, paidOrderId).shipping_amount, 1_000);
});

test("migration 0010 rejects negative shipping refund state", () => {
  const sqlite = database();
  const orderId = insertShippingOrder(sqlite, 4, 1_000);
  assert.throws(
    () => sqlite.prepare(
      "UPDATE orders SET shipping_refunded_amount = -1 WHERE id = ?",
    ).run(orderId),
    /CHECK constraint failed/,
  );
  assert.throws(
    () => sqlite.prepare(
      "UPDATE orders SET reserved_shipping_refund_amount = -1 WHERE id = ?",
    ).run(orderId),
    /CHECK constraint failed/,
  );
  assert.throws(
    () => insertRefundOperation(sqlite, orderId, 4, 1, -1),
    /CHECK constraint failed/,
  );
});

test("shipping reservation is atomic and cannot exceed the available amount", () => {
  const sqlite = database();
  const orderId = insertShippingOrder(sqlite, 5, 1_000);
  insertRefundOperation(sqlite, orderId, 5, 1_000, 1_000);
  assert.equal(shippingState(sqlite, orderId).reserved_shipping_refund_amount, 1_000);

  assert.throws(
    () => insertRefundOperation(sqlite, orderId, 6, 1, 1),
    /SHIPPING_REFUND_AMOUNT_UNAVAILABLE/,
  );
  assert.equal(shippingState(sqlite, orderId).reserved_shipping_refund_amount, 1_000);
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS count FROM refund_operations").get()?.count,
    1,
  );
});

test("shipping finalization moves the reservation exactly once", () => {
  const sqlite = database();
  const orderId = insertShippingOrder(sqlite, 7, 1_000);
  const operationId = insertRefundOperation(sqlite, orderId, 7, 1_000, 1_000);
  sqlite.prepare(
    `UPDATE refund_operations
     SET stripe_refund_id = ?, status = 'succeeded', updated_at = ?
     WHERE id = ?`,
  ).run("re_shippingRefund7", TIMESTAMP, operationId);

  assert.deepEqual(shippingState(sqlite, orderId), {
    shipping_amount: 1_000,
    shipping_refunded_amount: 1_000,
    reserved_shipping_refund_amount: 0,
  });
  assert.throws(
    () => insertRefundOperation(sqlite, orderId, 8, 1, 1),
    /SHIPPING_REFUND_AMOUNT_UNAVAILABLE/,
  );
});

test("a failed operation releases shipping for a later reservation", () => {
  const sqlite = database();
  const orderId = insertShippingOrder(sqlite, 9, 1_000);
  const operationId = insertRefundOperation(sqlite, orderId, 9, 1_000, 1_000);
  sqlite.prepare(
    "UPDATE refund_operations SET status = 'failed', updated_at = ? WHERE id = ?",
  ).run(TIMESTAMP, operationId);

  assert.deepEqual(shippingState(sqlite, orderId), {
    shipping_amount: 1_000,
    shipping_refunded_amount: null,
    reserved_shipping_refund_amount: 0,
  });
  insertRefundOperation(sqlite, orderId, 10, 1_000, 1_000);
  assert.equal(shippingState(sqlite, orderId).reserved_shipping_refund_amount, 1_000);
});

test("free and historical shipping cannot reserve a positive shipping refund", () => {
  const sqlite = database();
  const freeOrderId = insertShippingOrder(sqlite, 11, 0);
  const historicalOrderId = insertShippingOrder(sqlite, 12, null);
  assert.throws(
    () => insertRefundOperation(sqlite, freeOrderId, 11, 1, 1),
    /SHIPPING_REFUND_AMOUNT_UNAVAILABLE/,
  );
  assert.throws(
    () => insertRefundOperation(sqlite, historicalOrderId, 12, 1, 1),
    /SHIPPING_REFUND_AMOUNT_UNAVAILABLE/,
  );
});

test("product and shipping reservations coexist and finalize together", () => {
  const sqlite = database();
  const orderId = insertShippingOrder(sqlite, 13, 1_000);
  const orderLineId = insertOrderLine(sqlite, orderId, 13);
  const operationId = insertRefundOperation(sqlite, orderId, 13, 26_000, 1_000);
  insertRefundLine(sqlite, operationId, orderLineId, 13);

  sqlite.prepare(
    `UPDATE refund_operations
     SET stripe_refund_id = ?, status = 'succeeded', updated_at = ?
     WHERE id = ?`,
  ).run("re_shippingRefund13", TIMESTAMP, operationId);

  assert.deepEqual(shippingState(sqlite, orderId), {
    shipping_amount: 1_000,
    shipping_refunded_amount: 1_000,
    reserved_shipping_refund_amount: 0,
  });
  const lineState = sqlite.prepare(
    `SELECT refunded_quantity, reserved_refund_quantity
     FROM order_lines WHERE order_line_id = ?`,
  ).get(orderLineId);
  assert.equal(lineState?.refunded_quantity, 1);
  assert.equal(lineState?.reserved_refund_quantity, 0);
});

test("legacy product-only refunds keep their existing trigger behavior", () => {
  const sqlite = database();
  const orderId = insertShippingOrder(sqlite, 14, 1_000);
  const orderLineId = insertOrderLine(sqlite, orderId, 14);
  const operationId = insertRefundOperation(sqlite, orderId, 14, 25_000, null);
  insertRefundLine(sqlite, operationId, orderLineId, 14);

  sqlite.prepare(
    `UPDATE refund_operations
     SET stripe_refund_id = ?, status = 'succeeded', updated_at = ?
     WHERE id = ?`,
  ).run("re_shippingRefund14", TIMESTAMP, operationId);

  assert.deepEqual(shippingState(sqlite, orderId), {
    shipping_amount: 1_000,
    shipping_refunded_amount: null,
    reserved_shipping_refund_amount: null,
  });
  assert.equal(
    sqlite.prepare(
      "SELECT refunded_quantity FROM order_lines WHERE order_line_id = ?",
    ).get(orderLineId)?.refunded_quantity,
    1,
  );
});

test("a product refund pending at 0008 can finalize after migrations 0009 and 0010", () => {
  const sqlite = database(8);
  const orderId = insertHistoricalOrder(sqlite, 16);
  const orderLineId = insertOrderLine(sqlite, orderId, 16);
  const operationId = insertLegacyRefundOperation(sqlite, orderId, 16, 25_000);
  insertRefundLine(sqlite, operationId, orderLineId, 16);
  assert.equal(
    sqlite.prepare(
      "SELECT reserved_refund_quantity FROM order_lines WHERE order_line_id = ?",
    ).get(orderLineId)?.reserved_refund_quantity,
    1,
  );

  sqlite.exec(readFileSync("migrations/0009_add_shipping_to_orders.sql", "utf8"));
  sqlite.exec(readFileSync("migrations/0010_add_shipping_refunds.sql", "utf8"));
  sqlite.prepare(
    `UPDATE refund_operations
     SET stripe_refund_id = ?, status = 'succeeded', updated_at = ?
     WHERE id = ?`,
  ).run("re_legacyShippingRefund16", TIMESTAMP, operationId);

  assert.equal(
    sqlite.prepare(
      "SELECT refunded_quantity FROM order_lines WHERE order_line_id = ?",
    ).get(orderLineId)?.refunded_quantity,
    1,
  );
  assert.deepEqual(shippingState(sqlite, orderId), {
    shipping_amount: null,
    shipping_refunded_amount: null,
    reserved_shipping_refund_amount: null,
  });
});

test("an inconsistent combined total cannot be finalized and can still be released", () => {
  const sqlite = database();
  const orderId = insertShippingOrder(sqlite, 15, 1_000);
  const orderLineId = insertOrderLine(sqlite, orderId, 15);
  const operationId = insertRefundOperation(sqlite, orderId, 15, 25_999, 1_000);
  insertRefundLine(sqlite, operationId, orderLineId, 15);

  assert.throws(
    () => sqlite.prepare(
      `UPDATE refund_operations
       SET stripe_refund_id = ?, status = 'succeeded', updated_at = ?
       WHERE id = ?`,
    ).run("re_shippingRefund15", TIMESTAMP, operationId),
    /REFUND_FINALIZATION_CONFLICT/,
  );
  sqlite.prepare(
    "UPDATE refund_operations SET status = 'failed', updated_at = ? WHERE id = ?",
  ).run(TIMESTAMP, operationId);
  assert.equal(shippingState(sqlite, orderId).reserved_shipping_refund_amount, 0);
  assert.equal(
    sqlite.prepare(
      "SELECT reserved_refund_quantity FROM order_lines WHERE order_line_id = ?",
    ).get(orderLineId)?.reserved_refund_quantity,
    0,
  );
});

async function assertRefundPersistenceCode(
  action: () => Promise<unknown>,
  expectedCode: string,
) {
  await assert.rejects(action, (error) => {
    assert.equal(getRefundPersistenceErrorDetails(error).code, expectedCode);
    return true;
  });
}

test("refund services keep product-only shipping state untouched", async () => {
  const sqlite = database();
  const db = new ServiceDatabaseAdapter(sqlite);
  const orderId = insertShippingOrder(sqlite, 21, 1_000);
  const orderLineId = insertOrderLine(sqlite, orderId, 21);
  const context = await getRefundContext(db, orderLineId);
  assert.ok(context);

  const { operation, created } = await reserveRefundOperationLines(
    db,
    [context],
    [{ orderLineId, requestedQuantity: 1 }],
    identifier("aaaaaaaa-aaaa-4aaa-8aaa", 21),
  );
  assert.equal(created, true);
  assert.equal(operation.shippingRefundAmount, 0);
  assert.equal(operation.amount, 25_000);
  assert.deepEqual(shippingState(sqlite, orderId), {
    shipping_amount: 1_000,
    shipping_refunded_amount: null,
    reserved_shipping_refund_amount: null,
  });

  await finalizeRefundOperation(db, operation, "re_productOnlyService21");
  assert.deepEqual(shippingState(sqlite, orderId), {
    shipping_amount: 1_000,
    shipping_refunded_amount: null,
    reserved_shipping_refund_amount: null,
  });
});

test("refund services reserve products and shipping atomically", async () => {
  const sqlite = database();
  const db = new ServiceDatabaseAdapter(sqlite);
  const orderId = insertShippingOrder(sqlite, 22, 1_000);
  const orderLineId = insertOrderLine(sqlite, orderId, 22);
  const context = await getRefundContext(db, orderLineId);
  assert.ok(context);

  const { operation } = await reserveRefundOperationLines(
    db,
    [context],
    [{ orderLineId, requestedQuantity: 1 }],
    identifier("aaaaaaaa-aaaa-4aaa-8aaa", 22),
    1_000,
  );
  assert.equal(operation.amount, 26_000);
  assert.equal(operation.shippingRefundAmount, 1_000);
  assert.equal(shippingState(sqlite, orderId).reserved_shipping_refund_amount, 1_000);
  assert.equal(
    sqlite.prepare(
      "SELECT reserved_refund_quantity FROM order_lines WHERE order_line_id = ?",
    ).get(orderLineId)?.reserved_refund_quantity,
    1,
  );

  await finalizeRefundOperation(db, operation, "re_combinedService22");
  assert.deepEqual(shippingState(sqlite, orderId), {
    shipping_amount: 1_000,
    shipping_refunded_amount: 1_000,
    reserved_shipping_refund_amount: 0,
  });
  assert.equal(
    sqlite.prepare(
      "SELECT refunded_quantity FROM order_lines WHERE order_line_id = ?",
    ).get(orderLineId)?.refunded_quantity,
    1,
  );
});

test("shipping-only refunds support safe partial operations and one finalization", async () => {
  const sqlite = database();
  const db = new ServiceDatabaseAdapter(sqlite);
  const orderId = insertShippingOrder(sqlite, 23, 1_000);

  const first = await reserveShippingRefundOperation(
    db,
    orderId,
    400,
    identifier("aaaaaaaa-aaaa-4aaa-8aaa", 23),
  );
  assert.equal(first.operation.lines.length, 0);
  assert.equal(first.operation.amount, 400);
  await finalizeRefundOperation(db, first.operation, "re_shippingPartial23");
  await finalizeRefundOperation(db, first.operation, "re_shippingPartial23");

  const second = await reserveShippingRefundOperation(
    db,
    orderId,
    600,
    identifier("aaaaaaaa-aaaa-4aaa-8aaa", 24),
  );
  await finalizeRefundOperation(db, second.operation, "re_shippingRemainder24");
  assert.deepEqual(shippingState(sqlite, orderId), {
    shipping_amount: 1_000,
    shipping_refunded_amount: 1_000,
    reserved_shipping_refund_amount: 0,
  });

  await assertRefundPersistenceCode(
    () => reserveShippingRefundOperation(
      db,
      orderId,
      1,
      identifier("aaaaaaaa-aaaa-4aaa-8aaa", 25),
    ),
    "SHIPPING_REFUND_AMOUNT_UNAVAILABLE",
  );
});

test("refund services reject invalid and concurrently unavailable shipping amounts", async () => {
  const sqlite = database();
  const db = new ServiceDatabaseAdapter(sqlite);
  const orderId = insertShippingOrder(sqlite, 26, 1_000);

  for (const [suffix, amount] of [[26, -1], [27, 1.5], [28, Number.NaN]] as const) {
    await assertRefundPersistenceCode(
      () => reserveShippingRefundOperation(
        db,
        orderId,
        amount,
        identifier("aaaaaaaa-aaaa-4aaa-8aaa", suffix),
      ),
      "INVALID_SHIPPING_REFUND_AMOUNT",
    );
  }

  await reserveShippingRefundOperation(
    db,
    orderId,
    700,
    identifier("aaaaaaaa-aaaa-4aaa-8aaa", 29),
  );
  await assertRefundPersistenceCode(
    () => reserveShippingRefundOperation(
      db,
      orderId,
      301,
      identifier("aaaaaaaa-aaaa-4aaa-8aaa", 30),
    ),
    "SHIPPING_REFUND_AMOUNT_UNAVAILABLE",
  );
  assert.equal(shippingState(sqlite, orderId).reserved_shipping_refund_amount, 700);
});

test("a failed Stripe refund releases product and shipping reservations together", async () => {
  const sqlite = database();
  const db = new ServiceDatabaseAdapter(sqlite);
  const orderId = insertShippingOrder(sqlite, 31, 1_000);
  const orderLineId = insertOrderLine(sqlite, orderId, 31);
  const context = await getRefundContext(db, orderLineId);
  assert.ok(context);

  const { operation } = await reserveRefundOperationLines(
    db,
    [context],
    [{ orderLineId, requestedQuantity: 1 }],
    identifier("aaaaaaaa-aaaa-4aaa-8aaa", 31),
    1_000,
  );
  await failRefundOperation(db, operation, "re_failedService31", "STRIPE_REFUND_FAILED");

  assert.deepEqual(shippingState(sqlite, orderId), {
    shipping_amount: 1_000,
    shipping_refunded_amount: null,
    reserved_shipping_refund_amount: 0,
  });
  assert.equal(
    sqlite.prepare(
      "SELECT reserved_refund_quantity FROM order_lines WHERE order_line_id = ?",
    ).get(orderLineId)?.reserved_refund_quantity,
    0,
  );
});
