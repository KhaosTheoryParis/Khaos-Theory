import Stripe from "stripe";
import {
  getPennylaneErrorDetails,
  syncMultiLineRefundToPennylane,
  syncPaidCheckoutSessionToPennylane,
  syncTotalRefundToPennylane,
} from "./pennylane";
import {
  getOrderPersistenceErrorDetails,
  persistPaidOrder,
  type OrdersDatabase,
} from "./orders";
import {
  attachStripeRefundToOperation,
  failRefundOperation,
  finalizeRefundOperation,
  findRefundOperationById,
  getRefundOperationContexts,
  getRefundPersistenceErrorDetails,
  getRefundShippingContext,
  recordPennylaneCreditNote,
  type RefundContext,
  type RefundOperation,
  type RefundShippingContext,
} from "./refunds";

export type WebhookTrace = (
  stage: string,
  status: "start" | "success" | "error",
  event?: Stripe.Event,
  details?: Record<string, string | number | boolean | null>,
) => void;

export type StripeEventProcessingErrorDetails = {
  code: string;
  http_status?: number;
};

export class StripeEventProcessingError extends Error {
  readonly details: StripeEventProcessingErrorDetails;

  constructor(details: StripeEventProcessingErrorDetails) {
    super(details.code);
    this.name = "StripeEventProcessingError";
    this.details = details;
  }
}

export function createWebhookTrace(requestStartedAt: number, requestId: string): WebhookTrace {
  return (stage, status, event, details = {}) => {
    const eventObject = event?.data.object as { id?: string } | undefined;
    const checkoutSessionId = event?.type.startsWith("checkout.session.")
      ? (eventObject?.id ?? null)
      : null;

    const entry = {
      request_id: requestId,
      stripe_event_id: event?.id ?? null,
      event_type: event?.type ?? null,
      checkout_session_id: checkoutSessionId,
      stage,
      status,
      elapsed_ms: Date.now() - requestStartedAt,
      ...details,
    };

    if (status === "error") {
      console.error("STRIPE_WEBHOOK_TRACE", entry);
    } else {
      console.log("STRIPE_WEBHOOK_TRACE", entry);
    }
  };
}

async function createPennylaneInvoice(
  stripe: Stripe,
  session: Stripe.Checkout.Session,
  token: string | undefined,
  db: OrdersDatabase | undefined,
  event: Stripe.Event,
  trace: WebhookTrace,
) {
  const sessionId = session.id;
  trace("create_pennylane_invoice", "start", event);
  let processingErrorCode: string | null = null;

  if (!token) {
    trace("create_pennylane_invoice", "error", event, { code: "MISSING_PENNYLANE_API_TOKEN" });
    console.error("PENNYLANE_INVOICE_ERROR", {
      stripe_session_id: sessionId,
      code: "MISSING_PENNYLANE_API_TOKEN",
    });
    return {
      status: "error" as const,
      details: { code: "MISSING_PENNYLANE_API_TOKEN" },
    };
  }

  try {
    const result = await syncPaidCheckoutSessionToPennylane({
      stripe,
      sessionId,
      token,
      onProgress: ({ stage, status, details }) => {
        const traceStage = stage.startsWith("stripe.") ? stage : `pennylane.${stage}`;
        trace(traceStage, status, event, details);
      },
    });
    if (result.status === "already_exists") {
      console.log("PENNYLANE_INVOICE_ALREADY_EXISTS", {
        stripe_session_id: sessionId,
        pennylane_invoice_id: result.invoiceId,
        stripe_payment_intent_id: result.paymentIntentId,
      });
    } else {
      console.log("PENNYLANE_INVOICE_FINALIZED", {
        stripe_session_id: sessionId,
        pennylane_invoice_id: result.invoiceId,
        stripe_payment_intent_id: result.paymentIntentId,
        customer_email: result.customerEmail,
        amount: result.amount,
        currency: result.currency,
      });
    }

    if (result.markAsPaid.status === "marked_paid") {
      console.log("PENNYLANE_SANDBOX_INVOICE_MARKED_PAID", {
        pennylane_invoice_id: result.invoiceId,
        stripe_session_id: sessionId,
        stripe_payment_intent_id: result.paymentIntentId,
        amount: result.amount,
        currency: result.currency,
        remaining_amount_with_tax: result.markAsPaid.remainingAmountWithTax ?? null,
      });
    } else if (result.markAsPaid.status === "error") {
      console.error("PENNYLANE_MARK_AS_PAID_ERROR", {
        pennylane_invoice_id: result.invoiceId,
        stripe_session_id: sessionId,
        stripe_payment_intent_id: result.paymentIntentId,
        ...result.markAsPaid.error,
      });
    }

    if (result.email.status === "sent" && result.status === "created") {
      console.log("PENNYLANE_SANDBOX_INVOICE_EMAIL_SENT", {
        pennylane_invoice_id: result.invoiceId,
        stripe_session_id: sessionId,
        customer_email: result.customerEmail,
      });
    } else if (result.email.status === "error") {
      console.error("PENNYLANE_INVOICE_EMAIL_ERROR", {
        pennylane_invoice_id: result.invoiceId,
        stripe_session_id: sessionId,
        ...result.email.error,
      });
    }

    if (result.orderLineMappings.length > 0) {
      if (!db) {
        processingErrorCode = "MISSING_D1_DB_BINDING";
        console.error("ORDER_PERSISTENCE_ERROR", {
          stripe_session_id: sessionId,
          code: "MISSING_D1_DB_BINDING",
        });
      } else if (!result.customerEmail) {
        processingErrorCode = "MISSING_ORDER_CUSTOMER_EMAIL";
        console.error("ORDER_PERSISTENCE_ERROR", {
          stripe_session_id: sessionId,
          code: "MISSING_ORDER_CUSTOMER_EMAIL",
        });
      } else {
        try {
          trace("d1.write_orders", "start", event, { atomic_batch: true });
          trace("d1.write_order_lines", "start", event, {
            atomic_batch: true,
            line_count: result.orderLineMappings.length,
          });
          const persistence = await persistPaidOrder(db, {
            stripeCheckoutSessionId: sessionId,
            stripePaymentIntentId: result.paymentIntentId,
            pennylaneInvoiceId: String(result.invoiceId),
            customerName: result.customerName,
            customerEmail: result.customerEmail,
            currency: result.currency,
            amountTotal: result.amount,
            shipping: result.shipping,
            status: "paid",
            schemaVersion: 1,
            createdAt: result.createdAt,
            lines: result.orderLineMappings,
          });
          trace("d1.write_orders", "success", event, {
            atomic_batch: true,
            result: persistence.status,
          });
          trace("d1.write_order_lines", "success", event, {
            atomic_batch: true,
            result: persistence.status,
            line_count: result.orderLineMappings.length,
          });

          console.log(
            persistence.status === "created" ? "ORDER_PERSISTED" : "ORDER_ALREADY_EXISTS",
            {
              order_id: persistence.orderId,
              stripe_session_id: sessionId,
              pennylane_invoice_id: result.invoiceId,
              line_count: result.orderLineMappings.length,
            },
          );
        } catch (error) {
          const details = getOrderPersistenceErrorDetails(error);
          processingErrorCode = details.code;
          trace("d1.write_orders_and_order_lines", "error", event, { code: details.code });
          console.error("ORDER_PERSISTENCE_ERROR", {
            stripe_session_id: sessionId,
            pennylane_invoice_id: result.invoiceId,
            ...getOrderPersistenceErrorDetails(error),
          });
        }
      }
    }

    if (processingErrorCode) {
      trace("create_pennylane_invoice", "error", event, { code: processingErrorCode });
      return { status: "error" as const, details: { code: processingErrorCode } };
    }

    trace("create_pennylane_invoice", "success", event, { result: result.status });
    return { status: "success" as const, result: result.status };
  } catch (error) {
    const details = getPennylaneErrorDetails(error);
    trace("create_pennylane_invoice", "error", event, {
      code: details.code,
      operation: details.operation ?? null,
      stripe_operation: details.stripe_operation ?? null,
      stripe_resource: details.stripe_resource ?? null,
      duration_ms: details.duration_ms ?? null,
    });
    console.error("PENNYLANE_INVOICE_ERROR", {
      stripe_session_id: sessionId,
      ...getPennylaneErrorDetails(error),
    });
    return { status: "error" as const, details };
  }
}

async function createPennylaneCreditNote(
  stripe: Stripe,
  charge: Stripe.Charge,
  eventCreated: number,
  token: string | undefined,
) {
  const paymentIntentId =
    typeof charge.payment_intent === "string"
      ? charge.payment_intent
      : charge.payment_intent?.id;

  if (!token) {
    console.error("PENNYLANE_CREDIT_NOTE_ERROR", {
      stripe_charge_id: charge.id,
      stripe_payment_intent_id: paymentIntentId ?? null,
      code: "MISSING_PENNYLANE_API_TOKEN",
    });
    throw new Error("MISSING_PENNYLANE_API_TOKEN");
  }

  try {
    const result = await syncTotalRefundToPennylane({
      stripe,
      charge,
      eventCreated,
      token,
    });
    const logDetails = {
      stripe_charge_id: charge.id,
      stripe_payment_intent_id: result.paymentIntentId,
      pennylane_invoice_id: result.invoiceId,
      pennylane_credit_note_id: result.creditNoteId,
      amount: result.amount,
      currency: result.currency,
    };

    if (result.status === "already_exists") {
      console.log("PENNYLANE_CREDIT_NOTE_ALREADY_EXISTS", logDetails);
    } else {
      console.log("PENNYLANE_CREDIT_NOTE_FINALIZED", logDetails);
    }

    if (result.email.status === "sent" && result.status === "created") {
      console.log("PENNYLANE_SANDBOX_CREDIT_NOTE_EMAIL_SENT", {
        pennylane_credit_note_id: result.creditNoteId,
        pennylane_invoice_id: result.invoiceId,
        stripe_charge_id: charge.id,
        stripe_payment_intent_id: result.paymentIntentId,
        customer_email: result.customerEmail,
      });
    } else if (result.email.status === "error") {
      const emailError = result.email.error;

      console.error("PENNYLANE_CREDIT_NOTE_EMAIL_ERROR", {
        pennylane_credit_note_id: result.creditNoteId,
        pennylane_invoice_id: result.invoiceId,
        stripe_charge_id: charge.id,
        stripe_payment_intent_id: result.paymentIntentId,
        operation: emailError.operation ?? "send_credit_note_by_email",
        http_status: emailError.http_status,
        request_id: emailError.request_id,
        error_body: emailError.error_body,
        error_message:
          emailError.error_message ?? (emailError.error_body ? undefined : emailError.code),
      });
    }
  } catch (error) {
    console.error("PENNYLANE_CREDIT_NOTE_ERROR", {
      stripe_charge_id: charge.id,
      stripe_payment_intent_id: paymentIntentId ?? null,
      ...getPennylaneErrorDetails(error),
    });
    throw error;
  }
}

function requireStripeReference(
  value: string | { id: string } | null,
  prefix: "pi_" | "ch_",
) {
  const id = typeof value === "string" ? value : value?.id;

  if (!id || !id.startsWith(prefix)) throw new Error("STRIPE_REFUND_REFERENCE_MISSING");
  return id;
}

function requirePositiveIntegerMetadata(value: string | undefined) {
  if (!value || !/^\d+$/.test(value)) throw new Error("INVALID_REFUND_METADATA");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("INVALID_REFUND_METADATA");
  return parsed;
}

function getPartialRefundErrorDetails(error: unknown) {
  const persistence = getRefundPersistenceErrorDetails(error);
  if (persistence.code !== "UNEXPECTED_REFUND_PERSISTENCE_ERROR") return persistence;

  const pennylane = getPennylaneErrorDetails(error);
  if (pennylane.code !== "UNEXPECTED_PENNYLANE_ERROR") return pennylane;

  return {
    code: error instanceof Error ? error.message : "UNEXPECTED_PARTIAL_REFUND_ERROR",
  };
}

function validateRefundMapping(
  refund: Stripe.Refund,
  operation: RefundOperation,
  contexts: RefundContext[],
  orderContext: RefundContext | RefundShippingContext,
) {
  const metadata = refund.metadata ?? {};
  const productContext = contexts[0];
  const legacy = metadata.schema_version === "1";
  if (legacy && (operation.lines.length !== 1 || !productContext)) {
    throw new Error("STRIPE_REFUND_D1_MAPPING_MISMATCH");
  }
  const legacyQuantity = legacy ? requirePositiveIntegerMetadata(metadata.quantity) : null;
  const operationAmount = operation.lines.reduce(
    (total, line) => total + line.amount,
    operation.shippingRefundAmount ?? 0,
  );
  if (
    metadata.refund_operation_id !== operation.id ||
    metadata.checkout_session_id !== orderContext.stripeCheckoutSessionId ||
    (legacy && (metadata.order_line_id !== productContext?.orderLineId ||
      metadata.stripe_line_item_id !== productContext?.stripeLineItemId ||
      metadata.catalog_id !== productContext?.catalogId ||
      metadata.size_fr !== String(productContext?.sizeFr) ||
      legacyQuantity !== operation.lines[0].requestedQuantity)) ||
    (!legacy && (metadata.schema_version !== "3" || metadata.order_id !== operation.orderId)) ||
    refund.amount !== operationAmount || refund.amount !== operation.amount ||
    refund.currency !== orderContext.currency ||
    requireStripeReference(refund.payment_intent, "pi_") !== orderContext.stripePaymentIntentId ||
    (operation.stripeRefundId !== null && operation.stripeRefundId !== refund.id)
  ) {
    throw new Error("STRIPE_REFUND_D1_MAPPING_MISMATCH");
  }

}

async function verifyStructuredRefundWithStripe(
  stripe: Stripe,
  refund: Stripe.Refund,
  contexts: RefundContext[],
  operation: RefundOperation,
  orderContext: RefundContext | RefundShippingContext,
) {
  const paymentIntent = await stripe.paymentIntents.retrieve(orderContext.stripePaymentIntentId);
  const chargeId = requireStripeReference(paymentIntent.latest_charge, "ch_");

  if (
    paymentIntent.status !== "succeeded" ||
    paymentIntent.currency !== orderContext.currency ||
    paymentIntent.amount !== orderContext.amountTotal ||
    paymentIntent.amount_received !== orderContext.amountTotal
  ) {
    throw new Error("STRIPE_REFUND_PAYMENT_INTENT_MISMATCH");
  }

  const session = await stripe.checkout.sessions.retrieve(orderContext.stripeCheckoutSessionId);
  if (
    session.payment_status !== "paid" ||
    session.currency !== orderContext.currency ||
    session.amount_total !== orderContext.amountTotal ||
    requireStripeReference(session.payment_intent, "pi_") !== orderContext.stripePaymentIntentId
  ) {
    throw new Error("STRIPE_REFUND_CHECKOUT_SESSION_MISMATCH");
  }

  const charge = await stripe.charges.retrieve(chargeId);
  if (
    charge.currency !== orderContext.currency ||
    charge.amount !== orderContext.amountTotal ||
    requireStripeReference(charge.payment_intent, "pi_") !== orderContext.stripePaymentIntentId
  ) {
    throw new Error("STRIPE_REFUND_CHARGE_MISMATCH");
  }

  const lineItems = await stripe.checkout.sessions
    .listLineItems(orderContext.stripeCheckoutSessionId, { limit: 100 })
    .autoPagingToArray({ limit: 1_000 });
  const operationLines = new Map(operation.lines.map((line) => [line.orderLineId, line]));
  for (const selectedContext of contexts) {
    const operationLine = operationLines.get(selectedContext.orderLineId);
    const lineItem = lineItems.find((item) => item.id === selectedContext.stripeLineItemId);
    if (!operationLine || !lineItem ||
      lineItem.metadata?.order_line_id !== selectedContext.orderLineId ||
      lineItem.metadata?.catalog_id !== selectedContext.catalogId ||
      lineItem.metadata?.size_fr !== String(selectedContext.sizeFr) ||
      lineItem.metadata?.schema_version !== "1" || lineItem.currency !== selectedContext.currency ||
      lineItem.quantity !== selectedContext.quantity ||
      lineItem.amount_total !== selectedContext.unitAmount * selectedContext.quantity ||
      operationLine.unitAmount !== selectedContext.unitAmount) {
      throw new Error("STRIPE_REFUND_LINE_ITEM_MISMATCH");
    }
  }
  if (refund.amount !== operation.amount) {
    throw new Error("STRIPE_REFUND_LINE_ITEM_MISMATCH");
  }
}

type StructuredRefundDependencies = {
  retrieveRefund?: (stripe: Stripe, refundId: string) => Promise<Stripe.Refund>;
  findOperation?: typeof findRefundOperationById;
  getContexts?: typeof getRefundOperationContexts;
  getShippingContext?: typeof getRefundShippingContext;
  verifyWithStripe?: typeof verifyStructuredRefundWithStripe;
  attachRefund?: typeof attachStripeRefundToOperation;
  finalizeOperation?: typeof finalizeRefundOperation;
  failOperation?: typeof failRefundOperation;
  syncPennylane?: typeof syncMultiLineRefundToPennylane;
  recordCreditNote?: typeof recordPennylaneCreditNote;
};

function hasStructuredRefundMetadata(refund: Stripe.Refund) {
  const metadata = refund.metadata ?? {};
  return (
    (metadata.schema_version === "1" || metadata.schema_version === "3") &&
    typeof metadata.refund_operation_id === "string" &&
    typeof metadata.checkout_session_id === "string" &&
    (metadata.schema_version === "3"
      ? typeof metadata.order_id === "string"
      : typeof metadata.order_line_id === "string" &&
        typeof metadata.stripe_line_item_id === "string" &&
        typeof metadata.catalog_id === "string" &&
        typeof metadata.size_fr === "string" &&
        typeof metadata.quantity === "string")
  );
}

export async function processStructuredRefundEvent({
  stripe,
  eventRefund,
  eventCreated,
  eventType,
  stripeSecretKey,
  pennylaneToken,
  db,
  dependencies = {},
}: {
  stripe: Stripe;
  eventRefund: Stripe.Refund;
  eventCreated: number;
  eventType: "refund.created" | "refund.updated" | "refund.failed";
  stripeSecretKey: string;
  pennylaneToken: string | undefined;
  db: OrdersDatabase | undefined;
  dependencies?: StructuredRefundDependencies;
}) {
  if (!stripeSecretKey.startsWith("sk_test_")) {
    console.error("PENNYLANE_PARTIAL_CREDIT_NOTE_ERROR", {
      stripe_refund_id: eventRefund.id,
      code: "STRIPE_SANDBOX_REQUIRED",
    });
    throw new Error("STRIPE_SANDBOX_REQUIRED");
  }
  try {
    const refund = dependencies.retrieveRefund
      ? await dependencies.retrieveRefund(stripe, eventRefund.id)
      : await stripe.refunds.retrieve(eventRefund.id);

    if (!hasStructuredRefundMetadata(refund)) {
      console.error("unsupported_external_refund", {
        stripe_refund_id: refund.id,
        event_type: eventType,
        status: refund.status,
      });
      throw new Error("UNSUPPORTED_EXTERNAL_REFUND");
    }

    if (!db) throw new Error("MISSING_D1_DB_BINDING");

    const metadata = refund.metadata ?? {};
    const operationId = metadata.refund_operation_id;
    const operation = await (dependencies.findOperation ?? findRefundOperationById)(
      db,
      operationId as string,
    );
    if (!operation) throw new Error("REFUND_OPERATION_NOT_FOUND");
    const contexts = await (dependencies.getContexts ?? getRefundOperationContexts)(db, operation);
    if (contexts.length !== operation.lines.length) {
      throw new Error("ORDER_LINE_NOT_FOUND");
    }
    const orderContext = contexts[0] ?? await (
      dependencies.getShippingContext ?? getRefundShippingContext
    )(db, operation.orderId);
    if (!orderContext) throw new Error("ORDER_NOT_FOUND");
    validateRefundMapping(refund, operation, contexts, orderContext);

    await (dependencies.attachRefund ?? attachStripeRefundToOperation)(
      db,
      operation,
      refund.id,
    );

    if (refund.status === "pending" || refund.status === "requires_action") {
      console.log("REFUND_AWAITING_UPDATE", {
        stripe_refund_id: refund.id,
        refund_operation_id: operation.id,
        event_type: eventType,
        status: refund.status,
      });
      return { status: "pending" as const, refundId: refund.id };
    }

    if (refund.status === "failed" || refund.status === "canceled") {
      await (dependencies.failOperation ?? failRefundOperation)(
        db,
        operation,
        refund.id,
        `STRIPE_REFUND_${refund.status.toUpperCase()}`,
      );
      console.error("REFUND_FAILED", {
        stripe_refund_id: refund.id,
        refund_operation_id: operation.id,
        order_line_ids: operation.lines.map((line) => line.orderLineId),
        status: refund.status,
        failure_reason: refund.failure_reason ?? null,
      });
      return { status: "failed" as const, refundId: refund.id };
    }

    if (refund.status !== "succeeded") throw new Error("INVALID_STRIPE_REFUND_STATUS");
    if (!pennylaneToken) throw new Error("MISSING_PENNYLANE_API_TOKEN");

    await (dependencies.verifyWithStripe ?? verifyStructuredRefundWithStripe)(
      stripe,
      refund,
      contexts,
      operation,
      orderContext,
    );
    if (operation.status === "pending") {
      await (dependencies.finalizeOperation ?? finalizeRefundOperation)(
        db,
        operation,
        refund.id,
      );
    } else if (operation.status !== "succeeded") {
      throw new Error("REFUND_OPERATION_NOT_SUCCEEDED");
    }

    const contextById = new Map(contexts.map((item) => [item.orderLineId, item]));
    const result = await (dependencies.syncPennylane ?? syncMultiLineRefundToPennylane)({
      token: pennylaneToken,
      refundId: refund.id,
      refundCreated: eventCreated,
      paymentIntentId: orderContext.stripePaymentIntentId,
      checkoutSessionId: orderContext.stripeCheckoutSessionId,
      invoiceId: orderContext.pennylaneInvoiceId,
      lines: operation.lines.map((line) => {
        const lineContext = contextById.get(line.orderLineId);
        if (!lineContext) throw new Error("ORDER_LINE_NOT_FOUND");
        return {
          orderLineId: line.orderLineId,
          invoiceLineId: lineContext.pennylaneInvoiceLineId,
          quantity: line.requestedQuantity,
          unitAmount: line.unitAmount,
        };
      }),
      shippingRefundAmount: operation.shippingRefundAmount ?? 0,
      shippingAmountPaid: orderContext.shippingAmount ?? null,
      refundAmount: refund.amount,
      invoiceAmountTotal: orderContext.amountTotal,
      currency: orderContext.currency,
      customerEmail: orderContext.customerEmail,
    });

    await (dependencies.recordCreditNote ?? recordPennylaneCreditNote)(
      db,
      operation,
      String(result.creditNoteId),
    );
    const details = {
      stripe_refund_id: refund.id,
      refund_operation_id: operation.id,
      stripe_payment_intent_id: orderContext.stripePaymentIntentId,
      pennylane_invoice_id: result.invoiceId,
      pennylane_credit_note_id: result.creditNoteId,
      order_line_ids: operation.lines.map((line) => line.orderLineId),
      quantities: operation.lines.map((line) => line.requestedQuantity).join(","),
      amount: refund.amount,
      currency: refund.currency,
    };

    console.log(
      result.status === "created"
        ? "PENNYLANE_PARTIAL_CREDIT_NOTE_FINALIZED"
        : "PENNYLANE_PARTIAL_CREDIT_NOTE_ALREADY_EXISTS",
      details,
    );

    if (result.status === "created" && result.email.status === "sent") {
      console.log("PENNYLANE_SANDBOX_PARTIAL_CREDIT_NOTE_EMAIL_SENT", {
        pennylane_credit_note_id: result.creditNoteId,
        pennylane_invoice_id: result.invoiceId,
        stripe_refund_id: refund.id,
        refund_operation_id: operation.id,
        customer_email: orderContext.customerEmail,
      });
    } else if (result.status === "created" && result.email.status === "error") {
      const emailError = result.email.error;

      console.error("PENNYLANE_PARTIAL_CREDIT_NOTE_EMAIL_ERROR", {
        pennylane_credit_note_id: result.creditNoteId,
        pennylane_invoice_id: result.invoiceId,
        stripe_refund_id: refund.id,
        refund_operation_id: operation.id,
        operation: emailError.operation ?? "send_credit_note_by_email",
        http_status: emailError.http_status,
        request_id: emailError.request_id,
        error_body: emailError.error_body,
        error_message:
          emailError.error_message ?? (emailError.error_body ? undefined : emailError.code),
      });
    }
    return {
      status: result.status === "created" ? ("created" as const) : ("already_exists" as const),
      refundId: refund.id,
      creditNoteId: String(result.creditNoteId),
    };
  } catch (error) {
    console.error("PENNYLANE_PARTIAL_CREDIT_NOTE_ERROR", {
      stripe_refund_id: eventRefund.id,
      ...getPartialRefundErrorDetails(error),
    });
    throw error;
  }
}

export type StripeEventEnvironment = {
  STRIPE_SECRET_KEY: string;
  PENNYLANE_API_TOKEN?: string;
  DB?: OrdersDatabase;
};

export function createStripeClient(secretKey: string) {
  return new Stripe(secretKey, {
    timeout: 10_000,
    maxNetworkRetries: 0,
    httpClient: Stripe.createFetchHttpClient(),
  });
}

export async function processStripeEvent({
  event,
  env,
  trace,
  stripe = createStripeClient(env.STRIPE_SECRET_KEY),
}: {
  event: Stripe.Event;
  env: StripeEventEnvironment;
  trace: WebhookTrace;
  stripe?: Stripe;
}) {
  const pennylaneToken = env.PENNYLANE_API_TOKEN;
  trace("background_processing", "start", event);
  trace("event_processing", "start", event);

  try {
    switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;

      if (session.payment_status === "paid") {
        console.log("PAYMENT_SUCCEEDED", {
          session_id: session.id,
          payment_intent:
            typeof session.payment_intent === "string"
              ? session.payment_intent
              : (session.payment_intent?.id ?? null),
          amount_total: session.amount_total,
          currency: session.currency,
          customer_email: session.customer_details?.email ?? session.customer_email ?? null,
        });

        const outcome = await createPennylaneInvoice(
          stripe,
          session,
          pennylaneToken,
          env.DB,
          event,
          trace,
        );

        if (outcome.status === "error") {
          trace("event_processing", "error", event, { code: outcome.details.code });
          trace("background_processing", "error", event, { code: outcome.details.code });
          throw new StripeEventProcessingError(outcome.details);
        }
      } else {
        console.log("CHECKOUT_COMPLETED_NOT_PAID", {
          session_id: session.id,
          payment_status: session.payment_status,
        });
      }
      break;
    }

    case "payment_intent.payment_failed": {
      const paymentIntent = event.data.object;

      console.error("PAYMENT_FAILED", {
        payment_intent_id: paymentIntent.id,
        amount: paymentIntent.amount,
        currency: paymentIntent.currency,
        error_message: paymentIntent.last_payment_error?.message ?? null,
      });
      break;
    }

    case "checkout.session.expired": {
      const session = event.data.object;

      console.log("CHECKOUT_EXPIRED", { session_id: session.id });
      break;
    }

    case "refund.created": {
      await processStructuredRefundEvent({
        stripe,
        eventRefund: event.data.object,
        eventCreated: event.created,
        eventType: event.type,
        stripeSecretKey: env.STRIPE_SECRET_KEY,
        pennylaneToken,
        db: env.DB,
      });
      break;
    }

    case "refund.updated": {
      await processStructuredRefundEvent({
        stripe,
        eventRefund: event.data.object,
        eventCreated: event.created,
        eventType: event.type,
        stripeSecretKey: env.STRIPE_SECRET_KEY,
        pennylaneToken,
        db: env.DB,
      });
      break;
    }

    case "refund.failed": {
      await processStructuredRefundEvent({
        stripe,
        eventRefund: event.data.object,
        eventCreated: event.created,
        eventType: event.type,
        stripeSecretKey: env.STRIPE_SECRET_KEY,
        pennylaneToken,
        db: env.DB,
      });
      break;
    }

    case "charge.refunded": {
      const charge = event.data.object;

      console.log("PAYMENT_REFUNDED", {
        charge_id: charge.id,
        payment_intent:
          typeof charge.payment_intent === "string"
            ? charge.payment_intent
            : (charge.payment_intent?.id ?? null),
        amount_refunded: charge.amount_refunded,
        currency: charge.currency,
      });

      let refunds = charge.refunds?.data ?? [];

      const isStructuredKhaosRefund = (refund: Stripe.Refund) =>
        (refund.metadata?.schema_version === "1" ||
          refund.metadata?.schema_version === "3") &&
        typeof refund.metadata.refund_operation_id === "string";

      if (!refunds.some(isStructuredKhaosRefund)) {
        try {
          refunds = (await stripe.refunds.list({ charge: charge.id, limit: 100 })).data;
        } catch (error) {
          console.error("CHARGE_REFUND_LOOKUP_ERROR", {
            stripe_charge_id: charge.id,
            code: error instanceof Stripe.errors.StripeError ? error.code : "REFUND_LOOKUP_FAILED",
          });
          throw error;
        }
      }

      const hasStructuredRefund = refunds.some(isStructuredKhaosRefund);
      const hasExternalRefund = refunds.some((refund) => !isStructuredKhaosRefund(refund));

      if (hasStructuredRefund && hasExternalRefund) {
        console.error("unsupported_external_refund", {
          stripe_charge_id: charge.id,
          code: "UNSUPPORTED_EXTERNAL_REFUND",
          mixed_with_structured_refund: true,
        });
        throw new Error("UNSUPPORTED_EXTERNAL_REFUND");
      }

      if (hasStructuredRefund) {
        console.log("STRUCTURED_REFUND_HANDLED_BY_REFUND_CREATED", {
          stripe_charge_id: charge.id,
          amount_refunded: charge.amount_refunded,
          currency: charge.currency,
        });
        break;
      }

      if (charge.amount_refunded !== charge.amount) {
        console.log("REFUND_PARTIAL_NOT_SUPPORTED", {
          stripe_charge_id: charge.id,
          amount: charge.amount,
          amount_refunded: charge.amount_refunded,
          currency: charge.currency,
        });
        break;
      }

      await createPennylaneCreditNote(stripe, charge, event.created, pennylaneToken);
      break;
    }

      default:
        break;
    }
  } catch (error) {
    const details = getStripeEventProcessingErrorDetails(error);
    trace("event_processing", "error", event, { code: details.code });
    trace("background_processing", "error", event, { code: details.code });
    throw error;
  }

  trace("event_processing", "success", event);
  trace("background_processing", "success", event);
}

export function getStripeEventProcessingErrorDetails(
  error: unknown,
): StripeEventProcessingErrorDetails {
  if (error instanceof StripeEventProcessingError) return error.details;

  const pennylane = getPennylaneErrorDetails(error);
  if (pennylane.code !== "UNEXPECTED_PENNYLANE_ERROR") return pennylane;

  const orderPersistence = getOrderPersistenceErrorDetails(error);
  if (orderPersistence.code !== "UNEXPECTED_ORDER_PERSISTENCE_ERROR") return orderPersistence;

  const refundPersistence = getRefundPersistenceErrorDetails(error);
  if (refundPersistence.code !== "UNEXPECTED_REFUND_PERSISTENCE_ERROR") return refundPersistence;

  return {
    code: error instanceof Error ? error.message.slice(0, 200) : "UNEXPECTED_STRIPE_EVENT_ERROR",
  };
}
