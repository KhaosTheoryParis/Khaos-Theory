import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextResponse } from "next/server";
import Stripe from "stripe";
import {
  getPennylaneErrorDetails,
  syncPartialRefundToPennylane,
  syncPaidCheckoutSessionToPennylane,
  syncTotalRefundToPennylane,
} from "../../../services/pennylane";
import {
  getOrderPersistenceErrorDetails,
  persistPaidOrder,
  type OrdersDatabase,
} from "../../../services/orders";
import {
  attachStripeRefundToOperation,
  failRefundOperation,
  finalizeRefundOperation,
  findRefundOperationById,
  getRefundContext,
  getRefundPersistenceErrorDetails,
  recordPennylaneCreditNote,
  type RefundContext,
  type RefundOperation,
} from "../../../services/refunds";

export const runtime = "nodejs";

async function createPennylaneInvoice(
  stripe: Stripe,
  sessionId: string,
  token: string | undefined,
  db: OrdersDatabase | undefined,
) {
  if (!token) {
    console.error("PENNYLANE_INVOICE_ERROR", {
      stripe_session_id: sessionId,
      code: "MISSING_PENNYLANE_API_TOKEN",
    });
    return;
  }

  try {
    const result = await syncPaidCheckoutSessionToPennylane({ stripe, sessionId, token });

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
        console.error("ORDER_PERSISTENCE_ERROR", {
          stripe_session_id: sessionId,
          code: "MISSING_D1_DB_BINDING",
        });
      } else if (!result.customerEmail) {
        console.error("ORDER_PERSISTENCE_ERROR", {
          stripe_session_id: sessionId,
          code: "MISSING_ORDER_CUSTOMER_EMAIL",
        });
      } else {
        try {
          const persistence = await persistPaidOrder(db, {
            stripeCheckoutSessionId: sessionId,
            stripePaymentIntentId: result.paymentIntentId,
            pennylaneInvoiceId: String(result.invoiceId),
            customerEmail: result.customerEmail,
            currency: result.currency,
            amountTotal: result.amount,
            status: "paid",
            schemaVersion: 1,
            createdAt: result.createdAt,
            lines: result.orderLineMappings,
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
          console.error("ORDER_PERSISTENCE_ERROR", {
            stripe_session_id: sessionId,
            pennylane_invoice_id: result.invoiceId,
            ...getOrderPersistenceErrorDetails(error),
          });
        }
      }
    }
  } catch (error) {
    console.error("PENNYLANE_INVOICE_ERROR", {
      stripe_session_id: sessionId,
      ...getPennylaneErrorDetails(error),
    });
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
    return;
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
  context: RefundContext,
) {
  const metadata = refund.metadata ?? {};
  const requestedQuantity = requirePositiveIntegerMetadata(metadata.quantity);

  if (
    metadata.schema_version !== "1" ||
    metadata.refund_operation_id !== operation.id ||
    metadata.checkout_session_id !== context.stripeCheckoutSessionId ||
    metadata.order_line_id !== context.orderLineId ||
    metadata.stripe_line_item_id !== context.stripeLineItemId ||
    metadata.catalog_id !== context.catalogId ||
    metadata.size_fr !== String(context.sizeFr) ||
    requestedQuantity !== operation.requestedQuantity ||
    refund.amount !== context.unitAmount * requestedQuantity ||
    refund.amount !== operation.amount ||
    refund.currency !== context.currency ||
    requireStripeReference(refund.payment_intent, "pi_") !== context.stripePaymentIntentId ||
    (operation.stripeRefundId !== null && operation.stripeRefundId !== refund.id)
  ) {
    throw new Error("STRIPE_REFUND_D1_MAPPING_MISMATCH");
  }

  return requestedQuantity;
}

async function verifyStructuredRefundWithStripe(
  stripe: Stripe,
  refund: Stripe.Refund,
  context: RefundContext,
  requestedQuantity: number,
) {
  const paymentIntent = await stripe.paymentIntents.retrieve(context.stripePaymentIntentId);
  const chargeId = requireStripeReference(paymentIntent.latest_charge, "ch_");

  if (
    paymentIntent.status !== "succeeded" ||
    paymentIntent.currency !== context.currency ||
    paymentIntent.amount !== context.amountTotal ||
    paymentIntent.amount_received !== context.amountTotal
  ) {
    throw new Error("STRIPE_REFUND_PAYMENT_INTENT_MISMATCH");
  }

  const session = await stripe.checkout.sessions.retrieve(context.stripeCheckoutSessionId);
  if (
    session.payment_status !== "paid" ||
    session.currency !== context.currency ||
    session.amount_total !== context.amountTotal ||
    requireStripeReference(session.payment_intent, "pi_") !== context.stripePaymentIntentId
  ) {
    throw new Error("STRIPE_REFUND_CHECKOUT_SESSION_MISMATCH");
  }

  const charge = await stripe.charges.retrieve(chargeId);
  if (
    charge.currency !== context.currency ||
    charge.amount !== context.amountTotal ||
    requireStripeReference(charge.payment_intent, "pi_") !== context.stripePaymentIntentId
  ) {
    throw new Error("STRIPE_REFUND_CHARGE_MISMATCH");
  }

  const lineItems = await stripe.checkout.sessions
    .listLineItems(context.stripeCheckoutSessionId, { limit: 100 })
    .autoPagingToArray({ limit: 1_000 });
  const lineItem = lineItems.find((item) => item.id === context.stripeLineItemId);

  if (
    !lineItem ||
    lineItem.metadata?.order_line_id !== context.orderLineId ||
    lineItem.metadata?.catalog_id !== context.catalogId ||
    lineItem.metadata?.size_fr !== String(context.sizeFr) ||
    lineItem.metadata?.schema_version !== "1" ||
    lineItem.currency !== context.currency ||
    lineItem.quantity !== context.quantity ||
    lineItem.amount_total !== context.unitAmount * context.quantity ||
    refund.amount !== context.unitAmount * requestedQuantity
  ) {
    throw new Error("STRIPE_REFUND_LINE_ITEM_MISMATCH");
  }
}

async function processStructuredRefundCreated({
  stripe,
  eventRefund,
  eventCreated,
  stripeSecretKey,
  pennylaneToken,
  db,
}: {
  stripe: Stripe;
  eventRefund: Stripe.Refund;
  eventCreated: number;
  stripeSecretKey: string;
  pennylaneToken: string | undefined;
  db: OrdersDatabase | undefined;
}) {
  if (!stripeSecretKey.startsWith("sk_test_")) {
    console.error("PENNYLANE_PARTIAL_CREDIT_NOTE_ERROR", {
      stripe_refund_id: eventRefund.id,
      code: "STRIPE_SANDBOX_REQUIRED",
    });
    return;
  }
  if (!db || !pennylaneToken) {
    console.error("PENNYLANE_PARTIAL_CREDIT_NOTE_ERROR", {
      stripe_refund_id: eventRefund.id,
      code: !db ? "MISSING_D1_DB_BINDING" : "MISSING_PENNYLANE_API_TOKEN",
    });
    return;
  }

  try {
    const refund = await stripe.refunds.retrieve(eventRefund.id);
    const metadata = refund.metadata ?? {};
    const operationId = metadata.refund_operation_id;

    if (!operationId || metadata.schema_version !== "1") {
      throw new Error("INVALID_REFUND_METADATA");
    }

    const operation = await findRefundOperationById(db, operationId);
    if (!operation) throw new Error("REFUND_OPERATION_NOT_FOUND");
    const context = await getRefundContext(db, operation.orderLineId);
    if (!context) throw new Error("ORDER_LINE_NOT_FOUND");
    const requestedQuantity = validateRefundMapping(refund, operation, context);

    if (refund.status !== "succeeded") {
      console.log("REFUND_CREATED_PENDING", {
        stripe_refund_id: refund.id,
        refund_operation_id: operation.id,
        status: refund.status,
      });
      return;
    }

    await verifyStructuredRefundWithStripe(stripe, refund, context, requestedQuantity);
    await attachStripeRefundToOperation(db, operation, refund.id);
    if (operation.status === "pending") {
      await finalizeRefundOperation(db, operation, refund.id);
    } else if (operation.status !== "succeeded") {
      throw new Error("REFUND_OPERATION_NOT_SUCCEEDED");
    }

    const result = await syncPartialRefundToPennylane({
      token: pennylaneToken,
      refundId: refund.id,
      refundCreated: eventCreated,
      paymentIntentId: context.stripePaymentIntentId,
      checkoutSessionId: context.stripeCheckoutSessionId,
      invoiceId: context.pennylaneInvoiceId,
      invoiceLineId: context.pennylaneInvoiceLineId,
      quantity: requestedQuantity,
      unitAmount: context.unitAmount,
      refundAmount: refund.amount,
      invoiceAmountTotal: context.amountTotal,
      currency: context.currency,
      customerEmail: context.customerEmail,
    });

    await recordPennylaneCreditNote(db, operation, String(result.creditNoteId));
    const details = {
      stripe_refund_id: refund.id,
      refund_operation_id: operation.id,
      stripe_payment_intent_id: context.stripePaymentIntentId,
      pennylane_invoice_id: result.invoiceId,
      pennylane_credit_note_id: result.creditNoteId,
      order_line_id: context.orderLineId,
      quantity: requestedQuantity,
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
        customer_email: context.customerEmail,
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
  } catch (error) {
    console.error("PENNYLANE_PARTIAL_CREDIT_NOTE_ERROR", {
      stripe_refund_id: eventRefund.id,
      ...getPartialRefundErrorDetails(error),
    });
  }
}

async function processStructuredRefundFailed(
  refund: Stripe.Refund,
  db: OrdersDatabase | undefined,
) {
  const metadata = refund.metadata ?? {};
  const operationId = metadata.refund_operation_id;

  try {
    if (!db || !operationId || metadata.schema_version !== "1") {
      throw new Error(!db ? "MISSING_D1_DB_BINDING" : "INVALID_REFUND_METADATA");
    }
    const operation = await findRefundOperationById(db, operationId);
    if (!operation) throw new Error("REFUND_OPERATION_NOT_FOUND");
    const context = await getRefundContext(db, operation.orderLineId);
    if (!context) throw new Error("ORDER_LINE_NOT_FOUND");
    validateRefundMapping(refund, operation, context);
    await failRefundOperation(db, operation, refund.id);

    console.error("REFUND_FAILED", {
      stripe_refund_id: refund.id,
      refund_operation_id: operation.id,
      order_line_id: context.orderLineId,
      failure_reason: refund.failure_reason ?? null,
    });
  } catch (error) {
    console.error("REFUND_FAILED", {
      stripe_refund_id: refund.id,
      refund_operation_id: operationId ?? null,
      ...getPartialRefundErrorDetails(error),
    });
  }
}

export async function POST(req: Request) {
  const { env } = getCloudflareContext();
  const runtimeEnv = env as typeof env & {
    PENNYLANE_API_TOKEN?: string;
    DB?: OrdersDatabase;
  };
  const pennylaneToken = runtimeEnv.PENNYLANE_API_TOKEN;
  const signature = req.headers.get("stripe-signature");
  const payload = await req.text();

  if (!signature || !env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Missing Stripe signature or configuration." }, { status: 400 });
  }

  const stripe = new Stripe(env.STRIPE_SECRET_KEY);

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(payload, signature, env.STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    console.error(
      "Stripe webhook signature verification failed:",
      error instanceof Error ? error.message : "Unknown error",
    );

    return NextResponse.json({ error: "Invalid Stripe signature." }, { status: 400 });
  }

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

        await createPennylaneInvoice(stripe, session.id, pennylaneToken, runtimeEnv.DB);
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
      await processStructuredRefundCreated({
        stripe,
        eventRefund: event.data.object,
        eventCreated: event.created,
        stripeSecretKey: env.STRIPE_SECRET_KEY,
        pennylaneToken,
        db: runtimeEnv.DB,
      });
      break;
    }

    case "refund.failed": {
      await processStructuredRefundFailed(event.data.object, runtimeEnv.DB);
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

      if (!refunds.some((refund) => refund.metadata?.schema_version === "1")) {
        try {
          refunds = (await stripe.refunds.list({ charge: charge.id, limit: 100 })).data;
        } catch (error) {
          console.error("CHARGE_REFUND_LOOKUP_ERROR", {
            stripe_charge_id: charge.id,
            code: error instanceof Stripe.errors.StripeError ? error.code : "REFUND_LOOKUP_FAILED",
          });
          break;
        }
      }

      const hasStructuredRefund = refunds.some(
        (refund) =>
          refund.metadata?.schema_version === "1" &&
          typeof refund.metadata.refund_operation_id === "string",
      );

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

  return NextResponse.json({ received: true }, { status: 200 });
}
