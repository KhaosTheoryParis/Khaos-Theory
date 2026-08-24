import type { OrdersDatabase } from "./orders";

export type RefundContext = {
  orderId: string;
  orderLineId: string;
  stripeLineItemId: string;
  catalogId: string;
  sizeFr: number;
  quantity: number;
  unitAmount: number;
  refundedQuantity: number;
  reservedRefundQuantity: number;
  stripeCheckoutSessionId: string;
  stripePaymentIntentId: string;
  amountTotal: number;
  currency: string;
  orderStatus: string;
  schemaVersion: number;
  pennylaneInvoiceId: string;
  pennylaneInvoiceLineId: string;
  customerEmail: string;
};

export type RefundOperation = {
  id: string;
  orderLineId: string;
  requestedQuantity: number;
  refundedQuantityBefore: number;
  amount: number;
  currency: string;
  stripeIdempotencyKey: string;
  stripeRefundId: string | null;
  status: "pending" | "succeeded" | "failed";
  pennylaneCreditNoteId: string | null;
  creditNoteStatus: "pending" | "finalized";
};

type RefundContextRow = {
  order_id: string;
  order_line_id: string;
  stripe_line_item_id: string;
  catalog_id: string;
  size_fr: number;
  quantity: number;
  unit_amount: number;
  refunded_quantity: number;
  reserved_refund_quantity: number;
  stripe_checkout_session_id: string;
  stripe_payment_intent_id: string;
  amount_total: number;
  currency: string;
  order_status: string;
  schema_version: number;
  pennylane_invoice_id: string;
  pennylane_invoice_line_id: string;
  customer_email: string;
};

type RefundOperationRow = {
  id: string;
  order_line_id: string;
  requested_quantity: number;
  refunded_quantity_before: number;
  amount: number;
  currency: string;
  stripe_idempotency_key: string;
  stripe_refund_id: string | null;
  status: "pending" | "succeeded" | "failed";
  pennylane_credit_note_id: string | null;
  credit_note_status: "pending" | "finalized";
};

type RefundPersistenceErrorDetails = {
  code: string;
};

class RefundPersistenceError extends Error {
  readonly details: RefundPersistenceErrorDetails;

  constructor(code: string) {
    super(code);
    this.name = "RefundPersistenceError";
    this.details = { code };
  }
}

function mapOperation(row: RefundOperationRow): RefundOperation {
  return {
    id: row.id,
    orderLineId: row.order_line_id,
    requestedQuantity: row.requested_quantity,
    refundedQuantityBefore: row.refunded_quantity_before,
    amount: row.amount,
    currency: row.currency,
    stripeIdempotencyKey: row.stripe_idempotency_key,
    stripeRefundId: row.stripe_refund_id,
    status: row.status,
    pennylaneCreditNoteId: row.pennylane_credit_note_id,
    creditNoteStatus: row.credit_note_status,
  };
}

export async function getRefundContext(
  db: OrdersDatabase,
  orderLineId: string,
): Promise<RefundContext | null> {
  const row = await db
    .prepare(
      `SELECT
        o.id AS order_id,
        ol.order_line_id,
        ol.stripe_line_item_id,
        ol.catalog_id,
        ol.size_fr,
        ol.quantity,
        ol.unit_amount,
        ol.refunded_quantity,
        ol.reserved_refund_quantity,
        o.stripe_checkout_session_id,
        o.stripe_payment_intent_id,
        o.amount_total,
        o.currency,
        o.status AS order_status,
        o.schema_version
        ,o.pennylane_invoice_id
        ,ol.pennylane_invoice_line_id
        ,o.customer_email
      FROM order_lines ol
      INNER JOIN orders o ON o.id = ol.order_id
      WHERE ol.order_line_id = ?1`,
    )
    .bind(orderLineId)
    .first<RefundContextRow>();

  if (!row) return null;

  return {
    orderId: row.order_id,
    orderLineId: row.order_line_id,
    stripeLineItemId: row.stripe_line_item_id,
    catalogId: row.catalog_id,
    sizeFr: row.size_fr,
    quantity: row.quantity,
    unitAmount: row.unit_amount,
    refundedQuantity: row.refunded_quantity,
    reservedRefundQuantity: row.reserved_refund_quantity,
    stripeCheckoutSessionId: row.stripe_checkout_session_id,
    stripePaymentIntentId: row.stripe_payment_intent_id,
    amountTotal: row.amount_total,
    currency: row.currency,
    orderStatus: row.order_status,
    schemaVersion: row.schema_version,
    pennylaneInvoiceId: row.pennylane_invoice_id,
    pennylaneInvoiceLineId: row.pennylane_invoice_line_id,
    customerEmail: row.customer_email,
  };
}

export async function findRefundOperation(
  db: OrdersDatabase,
  orderLineId: string,
  requestedQuantity: number,
) {
  const row = await db
    .prepare(
      `SELECT * FROM refund_operations
       WHERE order_line_id = ?1 AND requested_quantity = ?2`,
    )
    .bind(orderLineId, requestedQuantity)
    .first<RefundOperationRow>();

  return row ? mapOperation(row) : null;
}

function verifyOperationMatchesContext(
  operation: RefundOperation,
  context: RefundContext,
  requestedQuantity: number,
) {
  if (
    operation.orderLineId !== context.orderLineId ||
    operation.requestedQuantity !== requestedQuantity ||
    operation.amount !== context.unitAmount * requestedQuantity ||
    operation.currency !== context.currency ||
    operation.refundedQuantityBefore < 0 ||
    operation.refundedQuantityBefore + requestedQuantity > context.quantity
  ) {
    throw new RefundPersistenceError("REFUND_OPERATION_CONFLICT");
  }

  if (
    operation.status === "pending" &&
    (context.refundedQuantity !== operation.refundedQuantityBefore ||
      context.reservedRefundQuantity < requestedQuantity)
  ) {
    throw new RefundPersistenceError("REFUND_RESERVATION_CONFLICT");
  }

  if (
    operation.status === "succeeded" &&
    context.refundedQuantity < operation.refundedQuantityBefore + requestedQuantity
  ) {
    throw new RefundPersistenceError("REFUND_FINALIZATION_CONFLICT");
  }
}

export async function reserveRefundOperation(
  db: OrdersDatabase,
  context: RefundContext,
  requestedQuantity: number,
) {
  const existingOperation = await findRefundOperation(
    db,
    context.orderLineId,
    requestedQuantity,
  );

  if (existingOperation) {
    verifyOperationMatchesContext(existingOperation, context, requestedQuantity);
    return { operation: existingOperation, created: false };
  }

  if (
    context.refundedQuantity + context.reservedRefundQuantity + requestedQuantity >
    context.quantity
  ) {
    throw new RefundPersistenceError("REFUND_QUANTITY_UNAVAILABLE");
  }

  const operation: RefundOperation = {
    id: crypto.randomUUID(),
    orderLineId: context.orderLineId,
    requestedQuantity,
    refundedQuantityBefore: context.refundedQuantity,
    amount: context.unitAmount * requestedQuantity,
    currency: context.currency,
    stripeIdempotencyKey: `khaos-refund-v1:${context.orderLineId}:${requestedQuantity}`,
    stripeRefundId: null,
    status: "pending",
    pennylaneCreditNoteId: null,
    creditNoteStatus: "pending",
  };
  const timestamp = new Date().toISOString();

  try {
    const result = await db
      .prepare(
        `INSERT INTO refund_operations (
          id, order_line_id, requested_quantity, refunded_quantity_before,
          amount, currency, stripe_idempotency_key, stripe_refund_id,
          status, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, 'pending', ?8, ?8)`,
      )
      .bind(
        operation.id,
        operation.orderLineId,
        operation.requestedQuantity,
        operation.refundedQuantityBefore,
        operation.amount,
        operation.currency,
        operation.stripeIdempotencyKey,
        timestamp,
      )
      .run();

    if (!result.success || result.meta?.changes !== 1) {
      throw new RefundPersistenceError("REFUND_RESERVATION_FAILED");
    }

    return { operation, created: true };
  } catch {
    const concurrentlyCreatedOperation = await findRefundOperation(
      db,
      context.orderLineId,
      requestedQuantity,
    );

    if (!concurrentlyCreatedOperation) {
      throw new RefundPersistenceError("REFUND_RESERVATION_CONFLICT");
    }

    const currentContext = await getRefundContext(db, context.orderLineId);

    if (!currentContext) {
      throw new RefundPersistenceError("ORDER_LINE_NOT_FOUND");
    }

    verifyOperationMatchesContext(
      concurrentlyCreatedOperation,
      currentContext,
      requestedQuantity,
    );
    return { operation: concurrentlyCreatedOperation, created: false };
  }
}

export async function finalizeRefundOperation(
  db: OrdersDatabase,
  operation: RefundOperation,
  stripeRefundId: string,
) {
  const timestamp = new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE refund_operations
       SET stripe_refund_id = ?1, status = 'succeeded', updated_at = ?2
       WHERE id = ?3 AND status = 'pending' AND stripe_refund_id IS NULL`,
    )
    .bind(stripeRefundId, timestamp, operation.id)
    .run();

  if (result.success && result.meta?.changes === 1) return;

  const persistedOperation = await findRefundOperation(
    db,
    operation.orderLineId,
    operation.requestedQuantity,
  );

  if (
    persistedOperation?.status === "succeeded" &&
    persistedOperation.stripeRefundId === stripeRefundId
  ) {
    return;
  }

  throw new RefundPersistenceError("REFUND_FINALIZATION_CONFLICT");
}

export async function findRefundOperationById(
  db: OrdersDatabase,
  operationId: string,
) {
  const row = await db
    .prepare("SELECT * FROM refund_operations WHERE id = ?1")
    .bind(operationId)
    .first<RefundOperationRow>();

  return row ? mapOperation(row) : null;
}

export async function attachStripeRefundToOperation(
  db: OrdersDatabase,
  operation: RefundOperation,
  stripeRefundId: string,
) {
  const timestamp = new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE refund_operations
       SET stripe_refund_id = ?1, updated_at = ?2
       WHERE id = ?3 AND status = 'pending'
         AND (stripe_refund_id IS NULL OR stripe_refund_id = ?1)`,
    )
    .bind(stripeRefundId, timestamp, operation.id)
    .run();

  if (result.success && result.meta?.changes === 1) return;

  const persisted = await findRefundOperationById(db, operation.id);
  if (persisted?.stripeRefundId === stripeRefundId) return;

  throw new RefundPersistenceError("REFUND_ID_ATTACHMENT_CONFLICT");
}

export async function failRefundOperation(
  db: OrdersDatabase,
  operation: RefundOperation,
  stripeRefundId: string,
) {
  if (operation.status === "failed" && operation.stripeRefundId === stripeRefundId) return;
  if (operation.status === "succeeded") return;

  const timestamp = new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE refund_operations
       SET stripe_refund_id = ?1, status = 'failed', updated_at = ?2
       WHERE id = ?3 AND status = 'pending'
         AND (stripe_refund_id IS NULL OR stripe_refund_id = ?1)`,
    )
    .bind(stripeRefundId, timestamp, operation.id)
    .run();

  if (!result.success || result.meta?.changes !== 1) {
    throw new RefundPersistenceError("REFUND_FAILURE_PERSISTENCE_CONFLICT");
  }
}

export async function recordPennylaneCreditNote(
  db: OrdersDatabase,
  operation: RefundOperation,
  creditNoteId: string,
) {
  const timestamp = new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE refund_operations
       SET pennylane_credit_note_id = ?1,
           credit_note_status = 'finalized',
           updated_at = ?2
       WHERE id = ?3 AND status = 'succeeded'
         AND (pennylane_credit_note_id IS NULL OR pennylane_credit_note_id = ?1)`,
    )
    .bind(creditNoteId, timestamp, operation.id)
    .run();

  if (result.success && result.meta?.changes === 1) return;

  const persisted = await findRefundOperationById(db, operation.id);
  if (
    persisted?.pennylaneCreditNoteId === creditNoteId &&
    persisted.creditNoteStatus === "finalized"
  ) {
    return;
  }

  throw new RefundPersistenceError("CREDIT_NOTE_PERSISTENCE_CONFLICT");
}

export function getRefundPersistenceErrorDetails(error: unknown): RefundPersistenceErrorDetails {
  return error instanceof RefundPersistenceError
    ? error.details
    : { code: "UNEXPECTED_REFUND_PERSISTENCE_ERROR" };
}
