import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import test from "node:test";
import type Stripe from "stripe";
import {
  attachStripeRefundToOperation,
  assertRefundOperationMatches,
  failRefundOperation,
  failRefundOperationBeforeStripe,
  finalizeRefundOperation,
  findRefundOperationById,
  getRefundContext,
  getRefundContexts,
  reserveRefundOperation,
  reserveRefundOperationLines,
  type RefundContext,
  type RefundOperation,
} from "../app/services/refunds";
import type { OrdersDatabase, OrdersPreparedStatement } from "../app/services/orders";
import { processStripeEvent, processStructuredRefundEvent } from "../app/services/stripe-events";

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const ORDER_LINE_ID = "22222222-2222-4222-8222-222222222222";
const ORDER_LINE_ID_2 = "66666666-6666-4666-8666-666666666666";
const OPERATION_1 = "33333333-3333-4333-8333-333333333333";
const OPERATION_2 = "44444444-4444-4444-8444-444444444444";
const CHECKOUT_ID = "cs_test_refundHardening";
const PAYMENT_INTENT_ID = "pi_refundHardening";
const STRIPE_LINE_ITEM_ID = "li_refundHardening";
type RefundStatus = NonNullable<Stripe.Refund["status"]>;

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
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) {
        const result = await statement.run();
        results.push({ success: result.success });
      }
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

function refundDatabase(quantity = 3) {
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
  ]) {
    sqlite.exec(readFileSync(migration, "utf8"));
  }

  const now = "2026-08-26T10:00:00.000Z";
  sqlite
    .prepare(
      `INSERT INTO orders (
        id, stripe_checkout_session_id, stripe_payment_intent_id,
        pennylane_invoice_id, customer_email, currency, amount_total,
        status, schema_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'eur', ?, 'paid', 1, ?, ?)`,
    )
    .run(
      ORDER_ID,
      CHECKOUT_ID,
      PAYMENT_INTENT_ID,
      "invoice-refund-hardening",
      "customer@example.test",
      quantity * 20_000,
      now,
      now,
    );
  sqlite
    .prepare(
      `INSERT INTO order_lines (
        id, order_id, order_line_id, stripe_line_item_id,
        pennylane_invoice_line_id, catalog_id, size_fr, quantity,
        unit_amount, refunded_quantity, reserved_refund_quantity,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'hollow-cross', 58, ?, 20000, 0, 0, ?, ?)`,
    )
    .run(
      "55555555-5555-4555-8555-555555555555",
      ORDER_ID,
      ORDER_LINE_ID,
      STRIPE_LINE_ITEM_ID,
      "invoice-line-refund-hardening",
      quantity,
      now,
      now,
    );

  return new SQLiteDatabaseAdapter(sqlite);
}

function multiLineRefundDatabase(firstQuantity = 2, secondQuantity = 2) {
  const db = refundDatabase(firstQuantity);
  const now = "2026-08-26T10:00:00.000Z";
  db.sqlite.prepare("UPDATE orders SET amount_total = ? WHERE id = ?")
    .run(firstQuantity * 20_000 + secondQuantity * 25_000, ORDER_ID);
  db.sqlite.prepare(
    `INSERT INTO order_lines (
      id, order_id, order_line_id, stripe_line_item_id,
      pennylane_invoice_line_id, catalog_id, size_fr, quantity,
      unit_amount, refunded_quantity, reserved_refund_quantity,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'geometry', 48, ?, 25000, 0, 0, ?, ?)`,
  ).run(
    "77777777-7777-4777-8777-777777777777",
    ORDER_ID,
    ORDER_LINE_ID_2,
    "li_refundHardeningTwo",
    "invoice-line-refund-hardening-two",
    secondQuantity,
    now,
    now,
  );
  return db;
}

async function multiContexts(db: OrdersDatabase) {
  return getRefundContexts(db, [ORDER_LINE_ID, ORDER_LINE_ID_2]);
}

async function requiredContext(db: OrdersDatabase) {
  const context = await getRefundContext(db, ORDER_LINE_ID);
  assert.ok(context);
  return context;
}

function operation(status: RefundOperation["status"] = "pending"): RefundOperation {
  return {
    id: OPERATION_1,
    orderId: ORDER_ID,
    orderLineId: ORDER_LINE_ID,
    requestedQuantity: 1,
    refundedQuantityBefore: 0,
    amount: 20_000,
    currency: "eur",
    stripeIdempotencyKey: `khaos-refund-v2:${OPERATION_1}`,
    stripeRefundId: status === "pending" ? null : "re_refundHardening",
    status,
    failureCode: null,
    pennylaneCreditNoteId: null,
    creditNoteStatus: "pending",
    lines: [{
      id: `${OPERATION_1}:${ORDER_LINE_ID}`,
      orderLineId: ORDER_LINE_ID,
      requestedQuantity: 1,
      refundedQuantityBefore: 0,
      unitAmount: 20_000,
      amount: 20_000,
    }],
  };
}

function context(): RefundContext {
  return {
    orderId: ORDER_ID,
    orderLineId: ORDER_LINE_ID,
    stripeLineItemId: STRIPE_LINE_ITEM_ID,
    catalogId: "hollow-cross",
    sizeFr: 58,
    quantity: 3,
    unitAmount: 20_000,
    refundedQuantity: 0,
    reservedRefundQuantity: 1,
    stripeCheckoutSessionId: CHECKOUT_ID,
    stripePaymentIntentId: PAYMENT_INTENT_ID,
    amountTotal: 60_000,
    currency: "eur",
    orderStatus: "paid",
    schemaVersion: 1,
    pennylaneInvoiceId: "invoice-refund-hardening",
    pennylaneInvoiceLineId: "invoice-line-refund-hardening",
    customerEmail: "customer@example.test",
  };
}

function refund(status: RefundStatus = "succeeded", structured = true): Stripe.Refund {
  return {
    id: "re_refundHardening",
    object: "refund",
    amount: 20_000,
    balance_transaction: null,
    charge: "ch_refundHardening",
    created: 0,
    currency: "eur",
    destination_details: null,
    failure_balance_transaction: null,
    failure_reason: status === "failed" ? "unknown" : null,
    instructions_email: null,
    metadata: structured
      ? {
          schema_version: "1",
          refund_operation_id: OPERATION_1,
          checkout_session_id: CHECKOUT_ID,
          order_line_id: ORDER_LINE_ID,
          stripe_line_item_id: STRIPE_LINE_ITEM_ID,
          catalog_id: "hollow-cross",
          size_fr: "58",
          quantity: "1",
        }
      : {},
    next_action: null,
    payment_intent: PAYMENT_INTENT_ID,
    pending_reason: null,
    reason: null,
    receipt_number: null,
    source_transfer_reversal: null,
    status,
    transfer_reversal: null,
  } as unknown as Stripe.Refund;
}

function lifecycleHarness(initialStatus: RefundStatus) {
  let currentStatus = initialStatus;
  let currentOperation = operation();
  let finalizeCount = 0;
  let failCount = 0;
  let creditNoteCreateCount = 0;
  let creditNoteExists = false;

  const dependencies = {
    retrieveRefund: async () => refund(currentStatus),
    findOperation: async () => currentOperation,
    getContexts: async () => [context()],
    verifyWithStripe: async () => undefined,
    attachRefund: async () => undefined,
    finalizeOperation: async () => {
      finalizeCount += 1;
      currentOperation = { ...currentOperation, status: "succeeded", stripeRefundId: "re_refundHardening" };
    },
    failOperation: async () => {
      failCount += 1;
      currentOperation = { ...currentOperation, status: "failed", stripeRefundId: "re_refundHardening" };
    },
    syncPennylane: async () => {
      if (!creditNoteExists) {
        creditNoteExists = true;
        creditNoteCreateCount += 1;
        return {
          status: "created" as const,
          invoiceId: "invoice-refund-hardening",
          creditNoteId: "credit-note-refund-hardening",
          amount: 20_000,
          currency: "eur",
          email: { status: "sent" as const },
        };
      }
      return {
        status: "already_exists" as const,
        invoiceId: "invoice-refund-hardening",
        creditNoteId: "credit-note-refund-hardening",
        amount: 20_000,
        currency: "eur",
        email: { status: "skipped_existing_invoice" as const },
      };
    },
    recordCreditNote: async () => undefined,
  };

  const run = (eventType: "refund.created" | "refund.updated" | "refund.failed") =>
    processStructuredRefundEvent({
      stripe: {} as Stripe,
      eventRefund: refund(currentStatus),
      eventCreated: 0,
      eventType,
      stripeSecretKey: "sk_test_not_real",
      pennylaneToken: "sandbox-not-real",
      db: {} as OrdersDatabase,
      dependencies: dependencies as never,
    });

  return {
    run,
    setStatus(status: RefundStatus) {
      currentStatus = status;
    },
    counts() {
      return { finalizeCount, failCount, creditNoteCreateCount };
    },
  };
}

test("refund.created succeeded finalizes and creates one credit note", async () => {
  const harness = lifecycleHarness("succeeded");
  const result = await harness.run("refund.created");
  assert.equal(result.status, "created");
  assert.deepEqual(harness.counts(), { finalizeCount: 1, failCount: 0, creditNoteCreateCount: 1 });
});

test("refund.created pending waits without finalizing or creating a credit note", async () => {
  const harness = lifecycleHarness("pending");
  const result = await harness.run("refund.created");
  assert.equal(result.status, "pending");
  assert.deepEqual(harness.counts(), { finalizeCount: 0, failCount: 0, creditNoteCreateCount: 0 });
});

test("refund.updated resumes a pending refund when it becomes succeeded", async () => {
  const harness = lifecycleHarness("pending");
  await harness.run("refund.created");
  harness.setStatus("succeeded");
  const result = await harness.run("refund.updated");
  assert.equal(result.status, "created");
  assert.deepEqual(harness.counts(), { finalizeCount: 1, failCount: 0, creditNoteCreateCount: 1 });
});

test("refund.updated to failed releases the operation without Pennylane", async () => {
  const harness = lifecycleHarness("pending");
  await harness.run("refund.created");
  harness.setStatus("failed");
  const result = await harness.run("refund.updated");
  assert.equal(result.status, "failed");
  assert.deepEqual(harness.counts(), { finalizeCount: 0, failCount: 1, creditNoteCreateCount: 0 });
});

test("refund.failed releases product and shipping reservations exactly once", async () => {
  const db = refundDatabase(3);
  db.sqlite.prepare(
    `UPDATE orders
     SET products_subtotal = 60000, shipping_amount = 1000,
         shipping_country = 'FR', shipping_zone = 'FR', amount_total = 61000
     WHERE id = ?`,
  ).run(ORDER_ID);
  db.sqlite.exec(
    `CREATE TABLE refund_operation_update_audit (operation_id TEXT NOT NULL);
     CREATE TRIGGER audit_refund_operation_updates
     AFTER UPDATE ON refund_operations
     BEGIN
       INSERT INTO refund_operation_update_audit (operation_id) VALUES (NEW.id);
     END;`,
  );

  const productContext = await requiredContext(db);
  const reservation = await reserveRefundOperationLines(
    db,
    [productContext],
    [{ orderLineId: ORDER_LINE_ID, requestedQuantity: 1 }],
    OPERATION_1,
    1_000,
  );
  const failedRefund = {
    ...refund("failed"),
    amount: 21_000,
    metadata: {
      schema_version: "3",
      refund_operation_id: OPERATION_1,
      checkout_session_id: CHECKOUT_ID,
      order_id: ORDER_ID,
    },
  } as Stripe.Refund;
  let pennylaneCreditNoteCalls = 0;
  const runFailedEvent = () => processStructuredRefundEvent({
    stripe: {} as Stripe,
    eventRefund: failedRefund,
    eventCreated: 0,
    eventType: "refund.failed",
    stripeSecretKey: "sk_test_not_real",
    pennylaneToken: undefined,
    db,
    dependencies: {
      retrieveRefund: async () => failedRefund,
      syncPennylane: async () => {
        pennylaneCreditNoteCalls += 1;
        throw new Error("UNEXPECTED_PENNYLANE_CREDIT_NOTE");
      },
    },
  });

  assert.equal(reservation.operation.amount, 21_000);
  assert.deepEqual(
    { ...db.sqlite.prepare(
      `SELECT refunded_quantity, reserved_refund_quantity
       FROM order_lines WHERE order_line_id = ?`,
    ).get(ORDER_LINE_ID) },
    { refunded_quantity: 0, reserved_refund_quantity: 1 },
  );
  assert.deepEqual(
    { ...db.sqlite.prepare(
      `SELECT shipping_refunded_amount, reserved_shipping_refund_amount
       FROM orders WHERE id = ?`,
    ).get(ORDER_ID) },
    { shipping_refunded_amount: null, reserved_shipping_refund_amount: 1_000 },
  );

  assert.deepEqual(await runFailedEvent(), {
    status: "failed",
    refundId: failedRefund.id,
  });
  const stateAfterFailure = {
    operation: { ...db.sqlite.prepare(
      `SELECT status, failure_code, stripe_refund_id, amount, shipping_refund_amount, updated_at
       FROM refund_operations WHERE id = ?`,
    ).get(OPERATION_1) },
    product: { ...db.sqlite.prepare(
      `SELECT refunded_quantity, reserved_refund_quantity
       FROM order_lines WHERE order_line_id = ?`,
    ).get(ORDER_LINE_ID) },
    shipping: { ...db.sqlite.prepare(
      `SELECT shipping_refunded_amount, reserved_shipping_refund_amount
       FROM orders WHERE id = ?`,
    ).get(ORDER_ID) },
  };
  const updateCountAfterFailure = db.sqlite.prepare(
    "SELECT COUNT(*) AS count FROM refund_operation_update_audit",
  ).get()?.count;
  assert.deepEqual(stateAfterFailure.product, {
    refunded_quantity: 0,
    reserved_refund_quantity: 0,
  });
  assert.deepEqual(stateAfterFailure.shipping, {
    shipping_refunded_amount: null,
    reserved_shipping_refund_amount: 0,
  });
  assert.deepEqual(stateAfterFailure.operation, {
    status: "failed",
    failure_code: "STRIPE_REFUND_FAILED",
    stripe_refund_id: failedRefund.id,
    amount: 21_000,
    shipping_refund_amount: 1_000,
    updated_at: (stateAfterFailure.operation as { updated_at: string }).updated_at,
  });
  assert.equal(pennylaneCreditNoteCalls, 0);

  assert.deepEqual(await runFailedEvent(), {
    status: "failed",
    refundId: failedRefund.id,
  });
  assert.deepEqual({
    operation: { ...db.sqlite.prepare(
      `SELECT status, failure_code, stripe_refund_id, amount, shipping_refund_amount, updated_at
       FROM refund_operations WHERE id = ?`,
    ).get(OPERATION_1) },
    product: { ...db.sqlite.prepare(
      `SELECT refunded_quantity, reserved_refund_quantity
       FROM order_lines WHERE order_line_id = ?`,
    ).get(ORDER_LINE_ID) },
    shipping: { ...db.sqlite.prepare(
      `SELECT shipping_refunded_amount, reserved_shipping_refund_amount
       FROM orders WHERE id = ?`,
    ).get(ORDER_ID) },
  }, stateAfterFailure);
  assert.equal(
    db.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM refund_operation_update_audit",
    ).get()?.count,
    updateCountAfterFailure,
  );
  assert.equal(pennylaneCreditNoteCalls, 0);
});

test("the same refund.created twice does not create two Pennylane credit notes", async () => {
  const harness = lifecycleHarness("succeeded");
  await harness.run("refund.created");
  await harness.run("refund.created");
  assert.deepEqual(harness.counts(), { finalizeCount: 1, failCount: 0, creditNoteCreateCount: 1 });
});

test("refund.created then refund.updated succeeded does not duplicate Pennylane", async () => {
  const harness = lifecycleHarness("succeeded");
  await harness.run("refund.created");
  await harness.run("refund.updated");
  assert.deepEqual(harness.counts(), { finalizeCount: 1, failCount: 0, creditNoteCreateCount: 1 });
});

test("successive one-unit refunds use distinct immutable operations", async () => {
  const db = refundDatabase(3);
  const firstContext = await requiredContext(db);
  const first = await reserveRefundOperation(db, firstContext, 1, OPERATION_1);
  await finalizeRefundOperation(db, first.operation, "re_successiveOne");

  const secondContext = await requiredContext(db);
  const second = await reserveRefundOperation(db, secondContext, 1, OPERATION_2);
  await finalizeRefundOperation(db, second.operation, "re_successiveTwo");

  const finalContext = await requiredContext(db);
  assert.equal(finalContext.refundedQuantity, 2);
  assert.equal(finalContext.reservedRefundQuantity, 0);
  const count = db.sqlite
    .prepare("SELECT COUNT(*) AS count FROM refund_operations")
    .get() as { count: number };
  assert.equal(count.count, 2);
  assert.notEqual(first.operation.stripeIdempotencyKey, second.operation.stripeIdempotencyKey);
});

test("concurrent requests with the same operation ID reserve only once", async () => {
  const db = refundDatabase(2);
  const initial = await requiredContext(db);
  const [first, second] = await Promise.all([
    reserveRefundOperation(db, initial, 1, OPERATION_1),
    reserveRefundOperation(db, initial, 1, OPERATION_1),
  ]);
  const state = await requiredContext(db);
  assert.equal(Number(first.created) + Number(second.created), 1);
  assert.equal(state.refundedQuantity, 0);
  assert.equal(state.reservedRefundQuantity, 1);
  const count = db.sqlite
    .prepare("SELECT COUNT(*) AS count FROM refund_operations")
    .get() as { count: number };
  assert.equal(count.count, 1);
});

test("a known permanent pre-Stripe error releases the reservation atomically", async () => {
  const db = refundDatabase(2);
  const reservation = await reserveRefundOperation(db, await requiredContext(db), 1, OPERATION_1);
  await failRefundOperationBeforeStripe(db, reservation.operation, "STRIPE_INVALID_REQUEST");
  const state = await requiredContext(db);
  const persisted = await findRefundOperationById(db, OPERATION_1);
  assert.equal(state.refundedQuantity, 0);
  assert.equal(state.reservedRefundQuantity, 0);
  assert.equal(persisted?.status, "failed");
  assert.equal(persisted?.failureCode, "STRIPE_INVALID_REQUEST");
});

test("a pending Refund is attached without consuming the reserved quantity", async () => {
  const db = refundDatabase(2);
  const reservation = await reserveRefundOperation(db, await requiredContext(db), 1, OPERATION_1);
  await attachStripeRefundToOperation(db, reservation.operation, "re_pendingRefund");
  const state = await requiredContext(db);
  const persisted = await findRefundOperationById(db, OPERATION_1);
  assert.equal(state.refundedQuantity, 0);
  assert.equal(state.reservedRefundQuantity, 1);
  assert.equal(persisted?.status, "pending");
  assert.equal(persisted?.stripeRefundId, "re_pendingRefund");
});

test("a failed Refund releases its reserved quantity without incrementing refunded quantity", async () => {
  const db = refundDatabase(2);
  const reservation = await reserveRefundOperation(db, await requiredContext(db), 1, OPERATION_1);
  await failRefundOperation(db, reservation.operation, "re_failedRefund", "STRIPE_REFUND_FAILED");
  const state = await requiredContext(db);
  const persisted = await findRefundOperationById(db, OPERATION_1);
  assert.equal(state.refundedQuantity, 0);
  assert.equal(state.reservedRefundQuantity, 0);
  assert.equal(persisted?.status, "failed");
  assert.equal(persisted?.failureCode, "STRIPE_REFUND_FAILED");
});

test("a transient pre-Stripe error keeps one reservation for an idempotent retry", async () => {
  const db = refundDatabase(2);
  const initial = await requiredContext(db);
  const first = await reserveRefundOperation(db, initial, 1, OPERATION_1);
  const retry = await reserveRefundOperation(db, await requiredContext(db), 1, OPERATION_1);
  const state = await requiredContext(db);
  assert.equal(first.created, true);
  assert.equal(retry.created, false);
  assert.equal(first.operation.stripeIdempotencyKey, retry.operation.stripeIdempotencyKey);
  assert.equal(state.refundedQuantity, 0);
  assert.equal(state.reservedRefundQuantity, 1);
  assert.equal((await findRefundOperationById(db, OPERATION_1))?.status, "pending");
});

test("an external refund without Khaos Theory metadata is terminal and has no side effects", async () => {
  let lookupCount = 0;
  await assert.rejects(
    processStructuredRefundEvent({
      stripe: {} as Stripe,
      eventRefund: refund("succeeded", false),
      eventCreated: 0,
      eventType: "refund.created",
      stripeSecretKey: "sk_test_not_real",
      pennylaneToken: "sandbox-not-real",
      db: {} as OrdersDatabase,
      dependencies: {
        retrieveRefund: async () => refund("succeeded", false),
        findOperation: async () => {
          lookupCount += 1;
          return null;
        },
      } as never,
    }),
    /UNSUPPORTED_EXTERNAL_REFUND/,
  );
  assert.equal(lookupCount, 0);
});

test("one selected line remains compatible with the historical refund workflow", async () => {
  const db = refundDatabase(2);
  const result = await reserveRefundOperationLines(
    db,
    [await requiredContext(db)],
    [{ orderLineId: ORDER_LINE_ID, requestedQuantity: 1 }],
    OPERATION_1,
  );
  assert.equal(result.created, true);
  assert.equal(result.operation.lines.length, 1);
  assert.equal(result.operation.amount, 20_000);
});

test("two different lines create one global refund operation with one amount", async () => {
  const db = multiLineRefundDatabase();
  const result = await reserveRefundOperationLines(
    db,
    await multiContexts(db),
    [
      { orderLineId: ORDER_LINE_ID, requestedQuantity: 1 },
      { orderLineId: ORDER_LINE_ID_2, requestedQuantity: 1 },
    ],
    OPERATION_1,
  );
  assert.equal(result.operation.lines.length, 2);
  assert.equal(result.operation.amount, 45_000);
  assert.equal(result.operation.stripeIdempotencyKey, `khaos-refund-v3:${OPERATION_1}`);
  const operationCount = db.sqlite.prepare("SELECT COUNT(*) AS count FROM refund_operations")
    .get() as { count: number };
  const lineCount = db.sqlite.prepare("SELECT COUNT(*) AS count FROM refund_operation_lines")
    .get() as { count: number };
  assert.equal(operationCount.count, 1);
  assert.equal(lineCount.count, 2);
});

test("different quantities on multiple lines reserve and finalize every line", async () => {
  const db = multiLineRefundDatabase(3, 3);
  const reservation = await reserveRefundOperationLines(
    db,
    await multiContexts(db),
    [
      { orderLineId: ORDER_LINE_ID, requestedQuantity: 2 },
      { orderLineId: ORDER_LINE_ID_2, requestedQuantity: 1 },
    ],
    OPERATION_1,
  );
  let contexts = await multiContexts(db);
  assert.deepEqual(contexts.map((item) => item.reservedRefundQuantity), [2, 1]);
  await finalizeRefundOperation(db, reservation.operation, "re_multiSucceeded");
  contexts = await multiContexts(db);
  assert.deepEqual(contexts.map((item) => item.refundedQuantity), [2, 1]);
  assert.deepEqual(contexts.map((item) => item.reservedRefundQuantity), [0, 0]);
});

test("a fully refunded or over-requested line is rejected by the database", async () => {
  const db = multiLineRefundDatabase(1, 1);
  db.sqlite.prepare(
    "UPDATE order_lines SET refunded_quantity = 1 WHERE order_line_id = ?",
  ).run(ORDER_LINE_ID);
  await assert.rejects(
    reserveRefundOperationLines(
      db,
      await multiContexts(db),
      [
        { orderLineId: ORDER_LINE_ID, requestedQuantity: 1 },
        { orderLineId: ORDER_LINE_ID_2, requestedQuantity: 1 },
      ],
      OPERATION_1,
    ),
    /REFUND_QUANTITY_UNAVAILABLE/,
  );
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS count FROM refund_operations")
    .get() as { count: number }).count, 0);
});

test("failure on the second line rolls back the first reservation atomically", async () => {
  const db = multiLineRefundDatabase(1, 1);
  const staleContexts = await multiContexts(db);
  db.sqlite.prepare(
    "UPDATE order_lines SET reserved_refund_quantity = 1 WHERE order_line_id = ?",
  ).run(ORDER_LINE_ID_2);
  await assert.rejects(
    reserveRefundOperationLines(
      db,
      staleContexts,
      [
        { orderLineId: ORDER_LINE_ID, requestedQuantity: 1 },
        { orderLineId: ORDER_LINE_ID_2, requestedQuantity: 1 },
      ],
      OPERATION_1,
    ),
    /REFUND_RESERVATION_CONFLICT/,
  );
  const rows = db.sqlite.prepare(
    "SELECT order_line_id, reserved_refund_quantity FROM order_lines ORDER BY order_line_id",
  ).all() as Array<{ order_line_id: string; reserved_refund_quantity: number }>;
  assert.deepEqual(rows.map((row) => row.reserved_refund_quantity), [0, 1]);
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS count FROM refund_operations")
    .get() as { count: number }).count, 0);
});

test("failed multi-line refund releases every reservation without refunding quantities", async () => {
  const db = multiLineRefundDatabase();
  const reservation = await reserveRefundOperationLines(
    db,
    await multiContexts(db),
    [
      { orderLineId: ORDER_LINE_ID, requestedQuantity: 1 },
      { orderLineId: ORDER_LINE_ID_2, requestedQuantity: 2 },
    ],
    OPERATION_1,
  );
  await failRefundOperation(db, reservation.operation, "re_multiFailed", "STRIPE_REFUND_FAILED");
  const contexts = await multiContexts(db);
  assert.deepEqual(contexts.map((item) => item.refundedQuantity), [0, 0]);
  assert.deepEqual(contexts.map((item) => item.reservedRefundQuantity), [0, 0]);
});

test("an identical operation is idempotent regardless of line order", async () => {
  const db = multiLineRefundDatabase();
  const selections = [
    { orderLineId: ORDER_LINE_ID, requestedQuantity: 1 },
    { orderLineId: ORDER_LINE_ID_2, requestedQuantity: 1 },
  ];
  const first = await reserveRefundOperationLines(db, await multiContexts(db), selections, OPERATION_1);
  const reversedContexts = await getRefundContexts(db, [ORDER_LINE_ID_2, ORDER_LINE_ID]);
  const retry = await reserveRefundOperationLines(db, reversedContexts, [...selections].reverse(), OPERATION_1);
  assert.equal(first.created, true);
  assert.equal(retry.created, false);
  assert.equal(retry.operation.stripeIdempotencyKey, first.operation.stripeIdempotencyKey);
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS count FROM refund_operations")
    .get() as { count: number }).count, 1);
});

test("an existing operation rejects different lines or quantities", async () => {
  const db = multiLineRefundDatabase(3, 3);
  const contexts = await multiContexts(db);
  const reservation = await reserveRefundOperationLines(
    db,
    contexts,
    [
      { orderLineId: ORDER_LINE_ID, requestedQuantity: 1 },
      { orderLineId: ORDER_LINE_ID_2, requestedQuantity: 1 },
    ],
    OPERATION_1,
  );
  assert.throws(
    () => assertRefundOperationMatches(
      reservation.operation,
      contexts,
      [{ orderLineId: ORDER_LINE_ID, requestedQuantity: 1 }],
    ),
    /REFUND_OPERATION_CONFLICT/,
  );
  assert.throws(
    () => assertRefundOperationMatches(
      reservation.operation,
      contexts,
      [
        { orderLineId: ORDER_LINE_ID, requestedQuantity: 2 },
        { orderLineId: ORDER_LINE_ID_2, requestedQuantity: 1 },
      ],
    ),
    /REFUND_OPERATION_CONFLICT/,
  );
});

test("concurrent multi-line operations sharing one line leave no partial second reservation", async () => {
  const db = multiLineRefundDatabase(1, 1);
  const staleContexts = await multiContexts(db);
  const first = await reserveRefundOperationLines(
    db,
    staleContexts,
    [
      { orderLineId: ORDER_LINE_ID, requestedQuantity: 1 },
      { orderLineId: ORDER_LINE_ID_2, requestedQuantity: 1 },
    ],
    OPERATION_1,
  );
  await assert.rejects(
    reserveRefundOperationLines(
      db,
      staleContexts,
      [
        { orderLineId: ORDER_LINE_ID, requestedQuantity: 1 },
        { orderLineId: ORDER_LINE_ID_2, requestedQuantity: 1 },
      ],
      OPERATION_2,
    ),
    /REFUND_RESERVATION_CONFLICT/,
  );
  const contexts = await multiContexts(db);
  assert.equal(first.created, true);
  assert.deepEqual(contexts.map((item) => item.reservedRefundQuantity), [1, 1]);
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS count FROM refund_operations")
    .get() as { count: number }).count, 1);
});

test("migration 0007 preserves a historical single-line refund operation", () => {
  const sqlite = new DatabaseSync(":memory:");
  for (const migration of [
    "migrations/0001_create_orders.sql",
    "migrations/0002_create_refund_operations.sql",
    "migrations/0003_track_refund_credit_notes.sql",
    "migrations/0006_harden_refund_operations.sql",
  ]) sqlite.exec(readFileSync(migration, "utf8"));
  const now = "2026-08-26T10:00:00.000Z";
  sqlite.prepare(
    `INSERT INTO orders (id, stripe_checkout_session_id, stripe_payment_intent_id,
      pennylane_invoice_id, customer_email, currency, amount_total, status,
      schema_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'eur', 20000, 'paid', 1, ?, ?)`,
  ).run(ORDER_ID, CHECKOUT_ID, PAYMENT_INTENT_ID, "invoice-legacy", "customer@example.test", now, now);
  sqlite.prepare(
    `INSERT INTO order_lines (id, order_id, order_line_id, stripe_line_item_id,
      pennylane_invoice_line_id, catalog_id, size_fr, quantity, unit_amount,
      refunded_quantity, reserved_refund_quantity, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'hollow-cross', 58, 1, 20000, 0, 0, ?, ?)`,
  ).run("55555555-5555-4555-8555-555555555555", ORDER_ID, ORDER_LINE_ID,
    STRIPE_LINE_ITEM_ID, "invoice-line-legacy", now, now);
  sqlite.prepare(
    `INSERT INTO refund_operations (id, order_line_id, requested_quantity,
      refunded_quantity_before, amount, currency, stripe_idempotency_key,
      stripe_refund_id, status, failure_code, pennylane_credit_note_id,
      credit_note_status, created_at, updated_at)
     VALUES (?, ?, 1, 0, 20000, 'eur', ?, NULL, 'pending', NULL, NULL, 'pending', ?, ?)`,
  ).run(OPERATION_1, ORDER_LINE_ID, `khaos-refund-v2:${OPERATION_1}`, now, now);
  sqlite.prepare(
    "UPDATE refund_operations SET stripe_refund_id = 're_legacy', status = 'succeeded' WHERE id = ?",
  ).run(OPERATION_1);
  sqlite.exec(readFileSync("migrations/0007_create_multi_line_refund_operations.sql", "utf8"));
  const migrated = sqlite.prepare(
    `SELECT ro.id, ro.order_id, ro.amount, ro.status, ro.stripe_refund_id,
      rol.order_line_id, rol.requested_quantity,
      rol.unit_amount FROM refund_operations ro INNER JOIN refund_operation_lines rol
      ON rol.refund_operation_id = ro.id`,
  ).get() as Record<string, string | number>;
  assert.deepEqual({ ...migrated }, {
    id: OPERATION_1,
    order_id: ORDER_ID,
    amount: 20_000,
    status: "succeeded",
    stripe_refund_id: "re_legacy",
    order_line_id: ORDER_LINE_ID,
    requested_quantity: 1,
    unit_amount: 20_000,
  });
  const foreignKeys = sqlite.prepare("PRAGMA foreign_key_list(refund_operation_lines)").all() as
    Array<{ table: string }>;
  assert.deepEqual(foreignKeys.map((key) => key.table).sort(), ["order_lines", "refund_operations"]);
  assert.equal((sqlite.prepare("PRAGMA foreign_key_check").all() as unknown[]).length, 0);
});

test("schema 3 structured refund creates one multi-line Pennylane synchronization", async () => {
  const multiOperation: RefundOperation = {
    ...operation(),
    amount: 45_000,
    stripeIdempotencyKey: `khaos-refund-v3:${OPERATION_1}`,
    lines: [
      operation().lines[0],
      { id: `${OPERATION_1}:${ORDER_LINE_ID_2}`, orderLineId: ORDER_LINE_ID_2,
        requestedQuantity: 1, refundedQuantityBefore: 0, unitAmount: 25_000, amount: 25_000 },
    ],
  };
  const secondContext: RefundContext = {
    ...context(),
    orderLineId: ORDER_LINE_ID_2,
    stripeLineItemId: "li_refundHardeningTwo",
    catalogId: "geometry",
    sizeFr: 48,
    unitAmount: 25_000,
    pennylaneInvoiceLineId: "invoice-line-refund-hardening-two",
  };
  const schemaThreeRefund = {
    ...refund("succeeded"),
    amount: 45_000,
    metadata: {
      schema_version: "3",
      refund_operation_id: OPERATION_1,
      checkout_session_id: CHECKOUT_ID,
      order_id: ORDER_ID,
    },
  } as Stripe.Refund;
  let syncCalls = 0;
  let synchronizedLines: unknown[] = [];
  const result = await processStructuredRefundEvent({
    stripe: {} as Stripe,
    eventRefund: schemaThreeRefund,
    eventCreated: 0,
    eventType: "refund.created",
    stripeSecretKey: "sk_test_not_real",
    pennylaneToken: "sandbox-not-real",
    db: {} as OrdersDatabase,
    dependencies: {
      retrieveRefund: async () => schemaThreeRefund,
      findOperation: async () => multiOperation,
      getContexts: async () => [context(), secondContext],
      verifyWithStripe: async () => undefined,
      attachRefund: async () => undefined,
      finalizeOperation: async () => undefined,
      syncPennylane: async (input) => {
        syncCalls += 1;
        synchronizedLines = input.lines;
        return { status: "created" as const, invoiceId: "invoice-refund-hardening",
          creditNoteId: "credit-note-multi", amount: 45_000, currency: "eur",
          email: { status: "sent" as const } };
      },
      recordCreditNote: async () => undefined,
    },
  });
  assert.equal(result.status, "created");
  assert.equal(syncCalls, 1);
  assert.deepEqual(synchronizedLines, [
    { orderLineId: ORDER_LINE_ID, invoiceLineId: "invoice-line-refund-hardening",
      quantity: 1, unitAmount: 20_000 },
    { orderLineId: ORDER_LINE_ID_2, invoiceLineId: "invoice-line-refund-hardening-two",
      quantity: 1, unitAmount: 25_000 },
  ]);
});

test("charge.refunded schema 3 remains diagnostic and never starts legacy credit-note work", async () => {
  let refundListCalls = 0;
  const structuredRefund = {
    ...refund("succeeded"),
    metadata: {
      schema_version: "3",
      refund_operation_id: OPERATION_1,
      checkout_session_id: CHECKOUT_ID,
      order_id: ORDER_ID,
    },
  } as Stripe.Refund;
  const charge = {
    id: "ch_refundHardening",
    object: "charge",
    amount: 20_000,
    amount_refunded: 20_000,
    currency: "eur",
    payment_intent: PAYMENT_INTENT_ID,
    refunds: { data: [structuredRefund] },
  } as unknown as Stripe.Charge;
  const event = {
    id: "evt_chargeRefundedSchemaThree",
    type: "charge.refunded",
    created: 0,
    data: { object: charge },
  } as Stripe.Event;
  await processStripeEvent({
    event,
    env: { STRIPE_SECRET_KEY: "sk_test_not_real", PENNYLANE_API_TOKEN: "sandbox-not-real" },
    stripe: {
      refunds: { list: async () => { refundListCalls += 1; return { data: [] }; } },
    } as unknown as Stripe,
    trace: () => undefined,
  });
  assert.equal(refundListCalls, 0);
});

test("charge.refunded rejects a mixed structured and external refund for manual review", async () => {
  const structuredRefund = {
    ...refund("succeeded"),
    id: "re_structuredMixedRefund",
    metadata: {
      schema_version: "3",
      refund_operation_id: OPERATION_1,
      checkout_session_id: CHECKOUT_ID,
      order_id: ORDER_ID,
    },
  } as Stripe.Refund;
  const externalRefund = {
    ...refund("succeeded", false),
    id: "re_externalMixedRefund",
    metadata: {},
  } as Stripe.Refund;
  const event = {
    id: "evt_chargeRefundedMixed",
    type: "charge.refunded",
    created: 0,
    data: { object: {
      id: "ch_refundHardening",
      object: "charge",
      amount: 45_000,
      amount_refunded: 45_000,
      currency: "eur",
      payment_intent: PAYMENT_INTENT_ID,
      refunds: { data: [structuredRefund, externalRefund] },
    } },
  } as unknown as Stripe.Event;

  await assert.rejects(
    processStripeEvent({
      event,
      env: { STRIPE_SECRET_KEY: "sk_test_not_real", PENNYLANE_API_TOKEN: "sandbox-not-real" },
      stripe: {} as Stripe,
      trace: () => undefined,
    }),
    /UNSUPPORTED_EXTERNAL_REFUND/,
  );
});

test("refund.created, refund.updated and charge.refunded schema 3 produce exactly one credit note", async () => {
  let currentOperation = { ...operation(), stripeIdempotencyKey: `khaos-refund-v3:${OPERATION_1}` };
  let creditNoteExists = false;
  let creditNoteCreateCount = 0;
  const structuredRefund = {
    ...refund("succeeded"),
    metadata: {
      schema_version: "3",
      refund_operation_id: OPERATION_1,
      checkout_session_id: CHECKOUT_ID,
      order_id: ORDER_ID,
    },
  } as Stripe.Refund;
  const dependencies = {
    retrieveRefund: async () => structuredRefund,
    findOperation: async () => currentOperation,
    getContexts: async () => [context()],
    verifyWithStripe: async () => undefined,
    attachRefund: async () => undefined,
    finalizeOperation: async () => {
      currentOperation = { ...currentOperation, status: "succeeded", stripeRefundId: structuredRefund.id };
    },
    syncPennylane: async () => {
      if (!creditNoteExists) {
        creditNoteExists = true;
        creditNoteCreateCount += 1;
        return { status: "created" as const, invoiceId: "invoice-refund-hardening",
          creditNoteId: "credit-note-schema-three", amount: 20_000, currency: "eur",
          email: { status: "sent" as const } };
      }
      return { status: "already_exists" as const, invoiceId: "invoice-refund-hardening",
        creditNoteId: "credit-note-schema-three", amount: 20_000, currency: "eur",
        email: { status: "skipped_existing_invoice" as const } };
    },
    recordCreditNote: async () => undefined,
  };
  for (const eventType of ["refund.created", "refund.updated"] as const) {
    await processStructuredRefundEvent({
      stripe: {} as Stripe,
      eventRefund: structuredRefund,
      eventCreated: 0,
      eventType,
      stripeSecretKey: "sk_test_not_real",
      pennylaneToken: "sandbox-not-real",
      db: {} as OrdersDatabase,
      dependencies,
    });
  }
  await processStripeEvent({
    event: {
      id: "evt_chargeRefundedAfterStructuredEvents",
      type: "charge.refunded",
      created: 0,
      data: { object: {
        id: "ch_refundHardening", amount: 20_000, amount_refunded: 20_000,
        currency: "eur", payment_intent: PAYMENT_INTENT_ID,
        refunds: { data: [structuredRefund] },
      } },
    } as Stripe.Event,
    env: { STRIPE_SECRET_KEY: "sk_test_not_real", PENNYLANE_API_TOKEN: "sandbox-not-real" },
    stripe: {} as Stripe,
    trace: () => undefined,
  });
  assert.equal(creditNoteCreateCount, 1);
});
