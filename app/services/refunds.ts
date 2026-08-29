import type { OrdersDatabase } from "./orders";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type RefundContext = {
  orderId: string; orderLineId: string; stripeLineItemId: string; catalogId: string;
  sizeFr: number; quantity: number; unitAmount: number; refundedQuantity: number;
  reservedRefundQuantity: number; stripeCheckoutSessionId: string;
  stripePaymentIntentId: string; amountTotal: number; currency: string;
  orderStatus: string; schemaVersion: number; pennylaneInvoiceId: string;
  pennylaneInvoiceLineId: string; customerEmail: string;
};

export type RefundOperationLine = {
  id: string; orderLineId: string; requestedQuantity: number;
  refundedQuantityBefore: number; unitAmount: number; amount: number;
};

export type RefundOperation = {
  id: string; orderId: string; amount: number; currency: string;
  stripeIdempotencyKey: string; stripeRefundId: string | null;
  status: "pending" | "succeeded" | "failed"; failureCode: string | null;
  pennylaneCreditNoteId: string | null; creditNoteStatus: "pending" | "finalized";
  lines: RefundOperationLine[];
  /** Compatibility aliases for historical single-line callers. */
  orderLineId: string; requestedQuantity: number; refundedQuantityBefore: number;
};

export type RefundSelection = { orderLineId: string; requestedQuantity: number };

export type RefundOrderSearchResult = {
  id: string; stripeCheckoutSessionId: string; stripePaymentIntentId: string;
  amountTotal: number; currency: string; status: string; schemaVersion: number;
  lines: Array<{
    orderLineId: string; catalogId: string; sizeFr: number; quantity: number;
    unitAmount: number; refundedQuantity: number; reservedRefundQuantity: number;
  }>;
};

type RefundContextRow = {
  order_id: string; order_line_id: string; stripe_line_item_id: string;
  catalog_id: string; size_fr: number; quantity: number; unit_amount: number;
  refunded_quantity: number; reserved_refund_quantity: number;
  stripe_checkout_session_id: string; stripe_payment_intent_id: string;
  amount_total: number; currency: string; order_status: string; schema_version: number;
  pennylane_invoice_id: string; pennylane_invoice_line_id: string; customer_email: string;
};
type RefundOperationRow = {
  id: string; order_id: string; amount: number; currency: string;
  stripe_idempotency_key: string; stripe_refund_id: string | null;
  status: "pending" | "succeeded" | "failed"; failure_code: string | null;
  pennylane_credit_note_id: string | null; credit_note_status: "pending" | "finalized";
};
type RefundOperationLineRow = {
  id: string; order_line_id: string; requested_quantity: number;
  refunded_quantity_before: number; unit_amount: number; amount: number;
};
type RefundOrderSearchRow = {
  id: string; stripe_checkout_session_id: string; stripe_payment_intent_id: string;
  amount_total: number; currency: string; status: string; schema_version: number;
};
type RefundOrderLineSearchRow = {
  order_line_id: string; catalog_id: string; size_fr: number; quantity: number;
  unit_amount: number; refunded_quantity: number; reserved_refund_quantity: number;
};
type RefundPersistenceErrorDetails = { code: string };

class RefundPersistenceError extends Error {
  readonly details: RefundPersistenceErrorDetails;
  constructor(code: string) { super(code); this.name = "RefundPersistenceError"; this.details = { code }; }
}

function mapContext(row: RefundContextRow): RefundContext {
  return {
    orderId: row.order_id, orderLineId: row.order_line_id,
    stripeLineItemId: row.stripe_line_item_id, catalogId: row.catalog_id,
    sizeFr: row.size_fr, quantity: row.quantity, unitAmount: row.unit_amount,
    refundedQuantity: row.refunded_quantity, reservedRefundQuantity: row.reserved_refund_quantity,
    stripeCheckoutSessionId: row.stripe_checkout_session_id,
    stripePaymentIntentId: row.stripe_payment_intent_id, amountTotal: row.amount_total,
    currency: row.currency, orderStatus: row.order_status, schemaVersion: row.schema_version,
    pennylaneInvoiceId: row.pennylane_invoice_id,
    pennylaneInvoiceLineId: row.pennylane_invoice_line_id, customerEmail: row.customer_email,
  };
}

function mapOperationLine(row: RefundOperationLineRow): RefundOperationLine {
  return { id: row.id, orderLineId: row.order_line_id,
    requestedQuantity: row.requested_quantity, refundedQuantityBefore: row.refunded_quantity_before,
    unitAmount: row.unit_amount, amount: row.amount };
}

async function mapOperation(db: OrdersDatabase, row: RefundOperationRow): Promise<RefundOperation> {
  const result = await db.prepare(
    `SELECT id, order_line_id, requested_quantity, refunded_quantity_before, unit_amount, amount
     FROM refund_operation_lines WHERE refund_operation_id = ?1 ORDER BY created_at, id`,
  ).bind(row.id).all<RefundOperationLineRow>();
  if (!result.success || result.results.length === 0) {
    throw new RefundPersistenceError("REFUND_OPERATION_LINES_NOT_FOUND");
  }
  const lines = result.results.map(mapOperationLine);
  const first = lines[0];
  return {
    id: row.id, orderId: row.order_id, amount: row.amount, currency: row.currency,
    stripeIdempotencyKey: row.stripe_idempotency_key, stripeRefundId: row.stripe_refund_id,
    status: row.status, failureCode: row.failure_code,
    pennylaneCreditNoteId: row.pennylane_credit_note_id, creditNoteStatus: row.credit_note_status,
    lines, orderLineId: first.orderLineId, requestedQuantity: first.requestedQuantity,
    refundedQuantityBefore: first.refundedQuantityBefore,
  };
}

export async function findRefundOrderByReference(db: OrdersDatabase, reference: string): Promise<RefundOrderSearchResult | null> {
  const result = await db.prepare(
    `SELECT id, stripe_checkout_session_id, stripe_payment_intent_id, amount_total, currency, status, schema_version
     FROM orders WHERE id = ?1 OR stripe_payment_intent_id = ?1 OR stripe_checkout_session_id = ?1`,
  ).bind(reference).all<RefundOrderSearchRow>();
  if (!result.success) throw new RefundPersistenceError("ORDER_LOOKUP_FAILED");
  if (result.results.length > 1) throw new RefundPersistenceError("ORDER_REFERENCE_CONFLICT");
  const order = result.results[0];
  if (!order) return null;
  const lines = await db.prepare(
    `SELECT order_line_id, catalog_id, size_fr, quantity, unit_amount, refunded_quantity, reserved_refund_quantity
     FROM order_lines WHERE order_id = ?1 ORDER BY created_at, id`,
  ).bind(order.id).all<RefundOrderLineSearchRow>();
  if (!lines.success || lines.results.length === 0) throw new RefundPersistenceError("ORDER_LINES_LOOKUP_FAILED");
  return {
    id: order.id, stripeCheckoutSessionId: order.stripe_checkout_session_id,
    stripePaymentIntentId: order.stripe_payment_intent_id, amountTotal: order.amount_total,
    currency: order.currency, status: order.status, schemaVersion: order.schema_version,
    lines: lines.results.map((line) => ({ orderLineId: line.order_line_id,
      catalogId: line.catalog_id, sizeFr: line.size_fr, quantity: line.quantity,
      unitAmount: line.unit_amount, refundedQuantity: line.refunded_quantity,
      reservedRefundQuantity: line.reserved_refund_quantity })),
  };
}

export async function getRefundContext(db: OrdersDatabase, orderLineId: string): Promise<RefundContext | null> {
  const row = await db.prepare(
    `SELECT o.id AS order_id, ol.order_line_id, ol.stripe_line_item_id, ol.catalog_id,
            ol.size_fr, ol.quantity, ol.unit_amount, ol.refunded_quantity,
            ol.reserved_refund_quantity, o.stripe_checkout_session_id,
            o.stripe_payment_intent_id, o.amount_total, o.currency,
            o.status AS order_status, o.schema_version, o.pennylane_invoice_id,
            ol.pennylane_invoice_line_id, o.customer_email
     FROM order_lines ol INNER JOIN orders o ON o.id = ol.order_id
     WHERE ol.order_line_id = ?1`,
  ).bind(orderLineId).first<RefundContextRow>();
  return row ? mapContext(row) : null;
}

export async function getRefundContexts(db: OrdersDatabase, orderLineIds: string[]): Promise<RefundContext[]> {
  if (orderLineIds.length === 0 || new Set(orderLineIds).size !== orderLineIds.length) {
    throw new RefundPersistenceError("INVALID_REFUND_OPERATION_LINES");
  }
  const contexts = await Promise.all(orderLineIds.map((id) => getRefundContext(db, id)));
  if (contexts.some((context) => !context)) throw new RefundPersistenceError("ORDER_LINE_NOT_FOUND");
  return contexts as RefundContext[];
}

export async function findRefundOperation(db: OrdersDatabase, operationId: string) {
  const row = await db.prepare("SELECT * FROM refund_operations WHERE id = ?1")
    .bind(operationId).first<RefundOperationRow>();
  return row ? mapOperation(db, row) : null;
}
export const findRefundOperationById = findRefundOperation;

export function assertRefundOperationMatches(
  operation: RefundOperation,
  contexts: RefundContext[],
  selections: RefundSelection[],
) {
  if (operation.lines.length !== selections.length || contexts.length !== selections.length) {
    throw new RefundPersistenceError("REFUND_OPERATION_CONFLICT");
  }
  const contextsById = new Map(contexts.map((context) => [context.orderLineId, context]));
  const selectionsById = new Map(selections.map((line) => [line.orderLineId, line]));
  const firstContext = contexts[0];
  if (!firstContext || operation.orderId !== firstContext.orderId ||
    operation.currency !== firstContext.currency ||
    contexts.some((context) => context.orderId !== firstContext.orderId ||
      context.stripeCheckoutSessionId !== firstContext.stripeCheckoutSessionId ||
      context.stripePaymentIntentId !== firstContext.stripePaymentIntentId ||
      context.currency !== firstContext.currency)) {
    throw new RefundPersistenceError("REFUND_OPERATION_CONFLICT");
  }
  let amount = 0;
  for (const line of operation.lines) {
    const context = contextsById.get(line.orderLineId);
    const selection = selectionsById.get(line.orderLineId);
    if (!context || !selection || operation.orderId !== context.orderId ||
      line.requestedQuantity !== selection.requestedQuantity || line.unitAmount !== context.unitAmount ||
      line.amount !== context.unitAmount * selection.requestedQuantity || line.refundedQuantityBefore < 0 ||
      line.refundedQuantityBefore + selection.requestedQuantity > context.quantity) {
      throw new RefundPersistenceError("REFUND_OPERATION_CONFLICT");
    }
    if (operation.status === "pending" &&
      (context.refundedQuantity !== line.refundedQuantityBefore || context.reservedRefundQuantity < selection.requestedQuantity)) {
      throw new RefundPersistenceError("REFUND_RESERVATION_CONFLICT");
    }
    if (operation.status === "succeeded" &&
      context.refundedQuantity < line.refundedQuantityBefore + selection.requestedQuantity) {
      throw new RefundPersistenceError("REFUND_FINALIZATION_CONFLICT");
    }
    amount += line.amount;
  }
  if (operation.amount !== amount) {
    throw new RefundPersistenceError("REFUND_OPERATION_CONFLICT");
  }
}

export async function reserveRefundOperationLines(
  db: OrdersDatabase, contexts: RefundContext[], selections: RefundSelection[], operationId: string,
) {
  if (!UUID_PATTERN.test(operationId)) throw new RefundPersistenceError("INVALID_REFUND_OPERATION_ID");
  if (contexts.length === 0 || contexts.length !== selections.length ||
    new Set(selections.map((line) => line.orderLineId)).size !== selections.length) {
    throw new RefundPersistenceError("INVALID_REFUND_OPERATION_LINES");
  }
  const sortedSelections = [...selections].sort((a, b) => a.orderLineId.localeCompare(b.orderLineId));
  const contextMap = new Map(contexts.map((context) => [context.orderLineId, context]));
  const completeContexts = sortedSelections.map((line) => contextMap.get(line.orderLineId));
  if (completeContexts.some((context) => !context)) throw new RefundPersistenceError("ORDER_LINE_NOT_FOUND");
  const checkedContexts = completeContexts as RefundContext[];
  const orderId = checkedContexts[0]?.orderId;
  const currency = checkedContexts[0]?.currency;
  if (!orderId || !currency || checkedContexts.some((context) => context.orderId !== orderId || context.currency !== currency)) {
    throw new RefundPersistenceError("REFUND_LINES_ORDER_CONFLICT");
  }
  const existing = await findRefundOperation(db, operationId);
  if (existing) {
    assertRefundOperationMatches(existing, checkedContexts, sortedSelections);
    return { operation: existing, created: false };
  }
  const timestamp = new Date().toISOString();
  const lines = sortedSelections.map((selection, index): RefundOperationLine => {
    const context = checkedContexts[index];
    if (!Number.isInteger(selection.requestedQuantity) || selection.requestedQuantity < 1 ||
      context.refundedQuantity + context.reservedRefundQuantity + selection.requestedQuantity > context.quantity) {
      throw new RefundPersistenceError("REFUND_QUANTITY_UNAVAILABLE");
    }
    return { id: `${operationId}:${context.orderLineId}`, orderLineId: context.orderLineId,
      requestedQuantity: selection.requestedQuantity, refundedQuantityBefore: context.refundedQuantity,
      unitAmount: context.unitAmount, amount: context.unitAmount * selection.requestedQuantity };
  });
  const operation: RefundOperation = {
    id: operationId, orderId, amount: lines.reduce((sum, line) => sum + line.amount, 0), currency,
    stripeIdempotencyKey: `khaos-refund-v3:${operationId}`, stripeRefundId: null,
    status: "pending", failureCode: null, pennylaneCreditNoteId: null,
    creditNoteStatus: "pending", lines, orderLineId: lines[0].orderLineId,
    requestedQuantity: lines[0].requestedQuantity, refundedQuantityBefore: lines[0].refundedQuantityBefore,
  };
  const statements = [
    db.prepare(
      `INSERT INTO refund_operations (id, order_id, amount, currency, stripe_idempotency_key,
       stripe_refund_id, status, failure_code, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, NULL, 'pending', NULL, ?6, ?6)`,
    ).bind(operation.id, operation.orderId, operation.amount, operation.currency, operation.stripeIdempotencyKey, timestamp),
    ...lines.map((line) => db.prepare(
      `INSERT INTO refund_operation_lines (id, refund_operation_id, order_line_id,
       requested_quantity, refunded_quantity_before, unit_amount, amount, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`,
    ).bind(line.id, operation.id, line.orderLineId, line.requestedQuantity,
      line.refundedQuantityBefore, line.unitAmount, line.amount, timestamp)),
  ];
  try {
    const results = await db.batch(statements);
    if (results.length !== statements.length || results.some((result) => !result.success)) {
      throw new RefundPersistenceError("REFUND_RESERVATION_FAILED");
    }
    return { operation, created: true };
  } catch {
    const concurrent = await findRefundOperation(db, operationId);
    if (!concurrent) throw new RefundPersistenceError("REFUND_RESERVATION_CONFLICT");
    const currentContexts = await getRefundContexts(db, concurrent.lines.map((line) => line.orderLineId));
    assertRefundOperationMatches(concurrent, currentContexts, sortedSelections);
    return { operation: concurrent, created: false };
  }
}

export async function reserveRefundOperation(db: OrdersDatabase, context: RefundContext, requestedQuantity: number, operationId: string) {
  return reserveRefundOperationLines(db, [context], [{ orderLineId: context.orderLineId, requestedQuantity }], operationId);
}

export async function getRefundOperationContexts(db: OrdersDatabase, operation: RefundOperation) {
  const contexts = await getRefundContexts(db, operation.lines.map((line) => line.orderLineId));
  if (contexts.some((context) => context.orderId !== operation.orderId)) {
    throw new RefundPersistenceError("REFUND_LINES_ORDER_CONFLICT");
  }
  return contexts;
}

export async function finalizeRefundOperation(db: OrdersDatabase, operation: RefundOperation, stripeRefundId: string) {
  const timestamp = new Date().toISOString();
  const result = await db.prepare(
    `UPDATE refund_operations SET stripe_refund_id = ?1, status = 'succeeded', updated_at = ?2
     WHERE id = ?3 AND status = 'pending' AND (stripe_refund_id IS NULL OR stripe_refund_id = ?1)`,
  ).bind(stripeRefundId, timestamp, operation.id).run();
  if (result.success && result.meta?.changes === 1) return;
  const persisted = await findRefundOperation(db, operation.id);
  if (persisted?.status === "succeeded" && persisted.stripeRefundId === stripeRefundId) return;
  throw new RefundPersistenceError("REFUND_FINALIZATION_CONFLICT");
}

export async function attachStripeRefundToOperation(db: OrdersDatabase, operation: RefundOperation, stripeRefundId: string) {
  const timestamp = new Date().toISOString();
  const result = await db.prepare(
    `UPDATE refund_operations SET stripe_refund_id = ?1, updated_at = ?2
     WHERE id = ?3 AND status = 'pending' AND (stripe_refund_id IS NULL OR stripe_refund_id = ?1)`,
  ).bind(stripeRefundId, timestamp, operation.id).run();
  if (result.success && result.meta?.changes === 1) return;
  const persisted = await findRefundOperation(db, operation.id);
  if (persisted?.stripeRefundId === stripeRefundId) return;
  throw new RefundPersistenceError("REFUND_ID_ATTACHMENT_CONFLICT");
}

export async function failRefundOperation(db: OrdersDatabase, operation: RefundOperation, stripeRefundId: string, failureCode = "STRIPE_REFUND_FAILED") {
  if (operation.status === "failed" && operation.stripeRefundId === stripeRefundId) return;
  if (operation.status === "succeeded") return;
  const timestamp = new Date().toISOString();
  const result = await db.prepare(
    `UPDATE refund_operations SET stripe_refund_id = ?1, status = 'failed', failure_code = ?2, updated_at = ?3
     WHERE id = ?4 AND status = 'pending' AND (stripe_refund_id IS NULL OR stripe_refund_id = ?1)`,
  ).bind(stripeRefundId, failureCode.slice(0, 200), timestamp, operation.id).run();
  if (!result.success || result.meta?.changes !== 1) throw new RefundPersistenceError("REFUND_FAILURE_PERSISTENCE_CONFLICT");
}

export async function failRefundOperationBeforeStripe(db: OrdersDatabase, operation: RefundOperation, failureCode: string) {
  if (operation.status === "failed") return;
  if (operation.status === "succeeded" || operation.stripeRefundId !== null) {
    throw new RefundPersistenceError("REFUND_PRE_STRIPE_FAILURE_CONFLICT");
  }
  const timestamp = new Date().toISOString();
  const result = await db.prepare(
    `UPDATE refund_operations SET status = 'failed', failure_code = ?1, updated_at = ?2
     WHERE id = ?3 AND status = 'pending' AND stripe_refund_id IS NULL`,
  ).bind(failureCode.slice(0, 200), timestamp, operation.id).run();
  if (result.success && result.meta?.changes === 1) return;
  const persisted = await findRefundOperation(db, operation.id);
  if (persisted?.status === "failed" && persisted.stripeRefundId === null) return;
  throw new RefundPersistenceError("REFUND_PRE_STRIPE_FAILURE_CONFLICT");
}

export async function recordPennylaneCreditNote(db: OrdersDatabase, operation: RefundOperation, creditNoteId: string) {
  const timestamp = new Date().toISOString();
  const result = await db.prepare(
    `UPDATE refund_operations SET pennylane_credit_note_id = ?1,
     credit_note_status = 'finalized', updated_at = ?2
     WHERE id = ?3 AND status = 'succeeded'
       AND (pennylane_credit_note_id IS NULL OR pennylane_credit_note_id = ?1)`,
  ).bind(creditNoteId, timestamp, operation.id).run();
  if (result.success && result.meta?.changes === 1) return;
  const persisted = await findRefundOperation(db, operation.id);
  if (persisted?.pennylaneCreditNoteId === creditNoteId && persisted.creditNoteStatus === "finalized") return;
  throw new RefundPersistenceError("CREDIT_NOTE_PERSISTENCE_CONFLICT");
}

export function getRefundPersistenceErrorDetails(error: unknown): RefundPersistenceErrorDetails {
  return error instanceof RefundPersistenceError ? error.details : { code: "UNEXPECTED_REFUND_PERSISTENCE_ERROR" };
}
