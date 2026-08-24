import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextResponse } from "next/server";
import Stripe from "stripe";
import type { OrdersDatabase } from "../../../services/orders";
import {
  finalizeRefundOperation,
  findRefundOperation,
  getRefundContext,
  getRefundPersistenceErrorDetails,
  reserveRefundOperation,
  type RefundContext,
  type RefundOperation,
} from "../../../services/refunds";

export const runtime = "nodejs";

type ValidatedStripeOrder = {
  charge: Stripe.Charge;
};

class RefundRouteError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = "RefundRouteError";
    this.status = status;
    this.code = code;
  }
}

function isStrictLocalSandbox(request: Request, stripeSecretKey: string | undefined) {
  const isLoopbackHost = (value: string | null) => {
    if (!value) return false;

    const normalized = value.trim().toLowerCase();
    const hostname = normalized.startsWith("[")
      ? normalized.slice(1, normalized.indexOf("]"))
      : normalized.split(":")[0];
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  };
  const urlIsLoopback = isLoopbackHost(new URL(request.url).hostname);
  const hostIsLoopback = isLoopbackHost(request.headers.get("host"));
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0] ?? null;
  const forwardedHostIsSafe = forwardedHost === null || isLoopbackHost(forwardedHost);

  return (
    urlIsLoopback &&
    hostIsLoopback &&
    forwardedHostIsSafe &&
    stripeSecretKey?.startsWith("sk_test_") === true
  );
}

function requirePaymentIntentId(value: string | Stripe.PaymentIntent | null) {
  const id = typeof value === "string" ? value : value?.id;

  if (!id || !/^pi_[A-Za-z0-9]+$/.test(id)) {
    throw new RefundRouteError(409, "STRIPE_PAYMENT_INTENT_MISMATCH");
  }

  return id;
}

function requireChargeId(value: string | Stripe.Charge | null) {
  const id = typeof value === "string" ? value : value?.id;

  if (!id || !/^ch_[A-Za-z0-9]+$/.test(id)) {
    throw new RefundRouteError(409, "STRIPE_CHARGE_MISSING");
  }

  return id;
}

function validateD1Context(context: RefundContext, requestedQuantity: number) {
  if (context.orderStatus !== "paid") {
    throw new RefundRouteError(409, "ORDER_NOT_PAID");
  }
  if (context.currency !== "eur") {
    throw new RefundRouteError(409, "ORDER_CURRENCY_NOT_SUPPORTED");
  }
  if (context.schemaVersion !== 1) {
    throw new RefundRouteError(409, "ORDER_SCHEMA_NOT_SUPPORTED");
  }
  if (!Number.isInteger(context.unitAmount) || context.unitAmount <= 0) {
    throw new RefundRouteError(409, "INVALID_ORDER_LINE_UNIT_AMOUNT");
  }
  if (
    !context.stripeCheckoutSessionId ||
    !/^cs_(?:test_|live_)?[A-Za-z0-9]+$/.test(context.stripeCheckoutSessionId) ||
    !context.stripePaymentIntentId ||
    !/^pi_[A-Za-z0-9]+$/.test(context.stripePaymentIntentId) ||
    !context.stripeLineItemId ||
    !/^li_[A-Za-z0-9]+$/.test(context.stripeLineItemId)
  ) {
    throw new RefundRouteError(409, "ORDER_STRIPE_REFERENCES_INVALID");
  }
  if (
    !Number.isInteger(requestedQuantity) ||
    requestedQuantity < 1 ||
    context.refundedQuantity + context.reservedRefundQuantity + requestedQuantity > context.quantity
  ) {
    throw new RefundRouteError(409, "REFUND_QUANTITY_UNAVAILABLE");
  }
}

async function validateStripeOrder(
  stripe: Stripe,
  context: RefundContext,
): Promise<ValidatedStripeOrder> {
  const paymentIntent = await stripe.paymentIntents.retrieve(context.stripePaymentIntentId);

  if (
    paymentIntent.id !== context.stripePaymentIntentId ||
    paymentIntent.status !== "succeeded" ||
    paymentIntent.currency !== "eur" ||
    paymentIntent.amount !== context.amountTotal ||
    paymentIntent.amount_received !== context.amountTotal
  ) {
    throw new RefundRouteError(409, "STRIPE_PAYMENT_INTENT_ORDER_MISMATCH");
  }

  const chargeId = requireChargeId(paymentIntent.latest_charge);
  const charge = await stripe.charges.retrieve(chargeId);

  if (
    charge.id !== chargeId ||
    charge.paid !== true ||
    charge.currency !== "eur" ||
    charge.amount !== context.amountTotal ||
    requirePaymentIntentId(charge.payment_intent) !== context.stripePaymentIntentId
  ) {
    throw new RefundRouteError(409, "STRIPE_CHARGE_ORDER_MISMATCH");
  }

  const session = await stripe.checkout.sessions.retrieve(context.stripeCheckoutSessionId);

  if (
    session.id !== context.stripeCheckoutSessionId ||
    session.mode !== "payment" ||
    session.payment_status !== "paid" ||
    session.currency !== "eur" ||
    session.amount_total !== context.amountTotal ||
    requirePaymentIntentId(session.payment_intent) !== context.stripePaymentIntentId
  ) {
    throw new RefundRouteError(409, "STRIPE_CHECKOUT_SESSION_ORDER_MISMATCH");
  }

  const lineItems = await stripe.checkout.sessions
    .listLineItems(session.id, { limit: 100 })
    .autoPagingToArray({ limit: 1_000 });
  const lineItem = lineItems.find((item) => item.id === context.stripeLineItemId);

  if (
    !lineItem ||
    lineItem.metadata?.order_line_id !== context.orderLineId ||
    lineItem.metadata?.catalog_id !== context.catalogId ||
    lineItem.metadata?.size_fr !== String(context.sizeFr) ||
    lineItem.metadata?.schema_version !== "1" ||
    lineItem.currency !== "eur" ||
    lineItem.quantity !== context.quantity ||
    lineItem.amount_total !== context.quantity * context.unitAmount ||
    lineItem.amount_discount !== 0 ||
    lineItem.amount_tax !== 0
  ) {
    throw new RefundRouteError(409, "STRIPE_LINE_ITEM_ORDER_MISMATCH");
  }

  return { charge };
}

function refundMetadata(context: RefundContext, operation: RefundOperation) {
  return {
    checkout_session_id: context.stripeCheckoutSessionId,
    order_line_id: context.orderLineId,
    stripe_line_item_id: context.stripeLineItemId,
    catalog_id: context.catalogId,
    size_fr: String(context.sizeFr),
    quantity: String(operation.requestedQuantity),
    schema_version: "1",
    refund_operation_id: operation.id,
  };
}

function validateStripeRefund(
  refund: Stripe.Refund,
  context: RefundContext,
  operation: RefundOperation,
) {
  const expectedMetadata = refundMetadata(context, operation);

  if (
    !/^re_[A-Za-z0-9]+$/.test(refund.id) ||
    refund.amount !== operation.amount ||
    refund.currency !== "eur" ||
    requirePaymentIntentId(refund.payment_intent) !== context.stripePaymentIntentId ||
    refund.status === "failed" ||
    refund.status === "canceled" ||
    Object.entries(expectedMetadata).some(([key, value]) => refund.metadata?.[key] !== value)
  ) {
    throw new RefundRouteError(409, "STRIPE_REFUND_MISMATCH");
  }

  return refund;
}

async function findStripeRefundForPendingOperation(
  stripe: Stripe,
  context: RefundContext,
  operation: RefundOperation,
) {
  const refunds = await stripe.refunds.list({
    payment_intent: context.stripePaymentIntentId,
    limit: 100,
  });
  const matches = refunds.data.filter(
    (refund) => refund.metadata?.refund_operation_id === operation.id,
  );

  if (matches.length > 1) {
    throw new RefundRouteError(409, "MULTIPLE_STRIPE_REFUNDS_FOR_OPERATION");
  }

  return matches[0]
    ? validateStripeRefund(matches[0], context, operation)
    : null;
}

function errorResponse(error: unknown) {
  if (error instanceof RefundRouteError) {
    return NextResponse.json({ ok: false, error: error.code }, { status: error.status });
  }

  const persistenceError = getRefundPersistenceErrorDetails(error);

  if (persistenceError.code !== "UNEXPECTED_REFUND_PERSISTENCE_ERROR") {
    const status =
      persistenceError.code === "ORDER_LINE_NOT_FOUND"
        ? 404
        : persistenceError.code.includes("QUANTITY") || persistenceError.code.includes("CONFLICT")
          ? 409
          : 503;

    return NextResponse.json({ ok: false, error: persistenceError.code }, { status });
  }

  if (error instanceof Stripe.errors.StripeError) {
    console.error("STRIPE_PARTIAL_REFUND_ERROR", {
      type: error.type,
      code: error.code,
      request_id: error.requestId,
    });
    return NextResponse.json({ ok: false, error: "STRIPE_REFUND_FAILED" }, { status: 502 });
  }

  console.error("PARTIAL_REFUND_ERROR", { code: "UNEXPECTED_PARTIAL_REFUND_ERROR" });
  return NextResponse.json({ ok: false, error: "REFUND_REQUEST_FAILED" }, { status: 500 });
}

export async function POST(request: Request) {
  const { env } = getCloudflareContext();
  const runtimeEnv = env as typeof env & { DB?: OrdersDatabase };

  if (!isStrictLocalSandbox(request, env.STRIPE_SECRET_KEY)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  if (!runtimeEnv.DB) {
    return NextResponse.json({ ok: false, error: "MISSING_D1_DB_BINDING" }, { status: 503 });
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "INVALID_JSON_REQUEST" }, { status: 400 });
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ ok: false, error: "INVALID_REFUND_REQUEST" }, { status: 400 });
  }

  const source = body as Record<string, unknown>;
  const keys = Object.keys(source).sort();
  const orderLineId = typeof source.order_line_id === "string" ? source.order_line_id.trim() : "";
  const quantity = source.quantity;

  if (
    keys.length !== 2 ||
    keys[0] !== "order_line_id" ||
    keys[1] !== "quantity" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      orderLineId,
    ) ||
    !Number.isInteger(quantity) ||
    (quantity as number) < 1
  ) {
    return NextResponse.json({ ok: false, error: "INVALID_REFUND_REQUEST" }, { status: 400 });
  }

  try {
    const db = runtimeEnv.DB;
    const requestedQuantity = quantity as number;
    const context = await getRefundContext(db, orderLineId);

    if (!context) {
      throw new RefundRouteError(404, "ORDER_LINE_NOT_FOUND");
    }

    const existingOperation = await findRefundOperation(db, orderLineId, requestedQuantity);

    if (!existingOperation) {
      validateD1Context(context, requestedQuantity);
    } else if (
      context.orderStatus !== "paid" ||
      context.currency !== "eur" ||
      context.schemaVersion !== 1
    ) {
      throw new RefundRouteError(409, "ORDER_NOT_REFUNDABLE");
    }

    const stripe = stripeForRefund(env.STRIPE_SECRET_KEY);
    const { charge } = await validateStripeOrder(stripe, context);

    if (existingOperation?.status === "succeeded" && existingOperation.stripeRefundId) {
      const refund = validateStripeRefund(
        await stripe.refunds.retrieve(existingOperation.stripeRefundId),
        context,
        existingOperation,
      );

      return NextResponse.json({
        ok: true,
        refund_id: refund.id,
        amount: refund.amount,
        currency: refund.currency,
      });
    }

    const reservation = await reserveRefundOperation(db, context, requestedQuantity);
    const operation = reservation.operation;

    if (reservation.created && charge.amount_refunded + operation.amount > charge.amount) {
      throw new RefundRouteError(409, "STRIPE_REFUND_AMOUNT_UNAVAILABLE");
    }

    let refund = await findStripeRefundForPendingOperation(stripe, context, operation);

    if (!refund) {
      refund = validateStripeRefund(
        await stripe.refunds.create(
          {
            payment_intent: context.stripePaymentIntentId,
            amount: operation.amount,
            metadata: refundMetadata(context, operation),
          },
          { idempotencyKey: operation.stripeIdempotencyKey },
        ),
        context,
        operation,
      );
    }

    if (refund.status === "succeeded") {
      try {
        await finalizeRefundOperation(db, operation, refund.id);
      } catch (error) {
        console.error("REFUND_D1_FINALIZATION_ERROR", {
          refund_operation_id: operation.id,
          stripe_refund_id: refund.id,
          order_line_id: context.orderLineId,
          ...getRefundPersistenceErrorDetails(error),
        });
        return NextResponse.json(
          { ok: false, error: "REFUND_PERSISTENCE_PENDING" },
          { status: 503 },
        );
      }
    }

    console.log("PARTIAL_REFUND_CREATED", {
      refund_id: refund.id,
      refund_operation_id: operation.id,
      order_line_id: context.orderLineId,
      amount: refund.amount,
      currency: refund.currency,
    });

    return NextResponse.json({
      ok: true,
      refund_id: refund.id,
      amount: refund.amount,
      currency: refund.currency,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

function stripeForRefund(secretKey: string) {
  return new Stripe(secretKey);
}
