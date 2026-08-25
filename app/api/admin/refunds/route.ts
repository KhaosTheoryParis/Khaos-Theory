import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextResponse } from "next/server";
import Stripe from "stripe";
import { verifyCloudflareAccess } from "../../../services/cloudflare-access";
import type { OrdersDatabase } from "../../../services/orders";
import {
  finalizeRefundOperation,
  findRefundOperation,
  findRefundOrderByReference,
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

const PRODUCTION_ADMIN_ORIGIN = "https://khaostheoryparis.com";
const ORDER_LINE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ORDER_REFERENCE_PATTERN =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|pi_[A-Za-z0-9]+|cs_(?:test_|live_)?[A-Za-z0-9]+)$/i;

const CATALOG_NAMES: Record<string, string> = {
  geometry: "Geometry",
  "carved-cross": "Karved Kross",
  "hollow-cross": "Hollow Kross",
  "signet-corner": "Signet Korner",
  "damaged-ring-i": "Damaged Ring I",
  "damaged-ring-ii": "Damaged Ring II",
};

type ParsedRefundRequest =
  | { action: "search"; reference: string }
  | { action: "preview"; orderLineId: string }
  | { action: "refund"; orderLineId: string; amount: number };

function isLoopbackHostname(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function hasTrustedAdminOrigin(request: Request, stripeSecretKey: string | undefined) {
  const originHeader = request.headers.get("origin")?.trim();

  if (!originHeader) return false;

  let requestUrl: URL;
  let originUrl: URL;

  try {
    requestUrl = new URL(request.url);
    originUrl = new URL(originHeader);
  } catch {
    return false;
  }

  const fetchSite = request.headers.get("sec-fetch-site");

  if (fetchSite && fetchSite !== "same-origin") return false;

  if (
    requestUrl.origin === PRODUCTION_ADMIN_ORIGIN &&
    originUrl.origin === PRODUCTION_ADMIN_ORIGIN
  ) {
    return true;
  }

  return (
    stripeSecretKey?.startsWith("sk_test_") === true &&
    isLoopbackHostname(requestUrl.hostname) &&
    isLoopbackHostname(originUrl.hostname) &&
    requestUrl.origin === originUrl.origin
  );
}

function parseRefundRequest(body: unknown): ParsedRefundRequest | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;

  const source = body as Record<string, unknown>;
  const action = source.action;
  const reference = typeof source.reference === "string" ? source.reference.trim() : "";
  const orderLineId = typeof source.order_line_id === "string" ? source.order_line_id.trim() : "";

  if (
    action === "search" &&
    Object.keys(source).length === 2 &&
    Object.hasOwn(source, "action") &&
    Object.hasOwn(source, "reference") &&
    ORDER_REFERENCE_PATTERN.test(reference)
  ) {
    return { action, reference };
  }

  if (!ORDER_LINE_ID_PATTERN.test(orderLineId)) return null;

  if (
    action === "preview" &&
    Object.keys(source).length === 2 &&
    Object.hasOwn(source, "action") &&
    Object.hasOwn(source, "order_line_id")
  ) {
    return { action, orderLineId };
  }

  if (
    action === "refund" &&
    Object.keys(source).length === 3 &&
    Object.hasOwn(source, "action") &&
    Object.hasOwn(source, "amount") &&
    Object.hasOwn(source, "order_line_id") &&
    Number.isSafeInteger(source.amount) &&
    (source.amount as number) > 0
  ) {
    return { action, orderLineId, amount: source.amount as number };
  }

  return null;
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

function validateRefundableContext(context: RefundContext) {
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
    !Number.isInteger(context.quantity) ||
    !Number.isInteger(context.refundedQuantity) ||
    !Number.isInteger(context.reservedRefundQuantity) ||
    context.quantity < 1 ||
    context.refundedQuantity < 0 ||
    context.reservedRefundQuantity < 0 ||
    context.refundedQuantity + context.reservedRefundQuantity > context.quantity
  ) {
    throw new RefundRouteError(409, "INVALID_ORDER_LINE_REFUND_STATE");
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
}

function validateD1Context(context: RefundContext, requestedQuantity: number) {
  validateRefundableContext(context);

  if (
    !Number.isInteger(requestedQuantity) ||
    requestedQuantity < 1 ||
    context.refundedQuantity + context.reservedRefundQuantity + requestedQuantity > context.quantity
  ) {
    throw new RefundRouteError(409, "REFUND_QUANTITY_UNAVAILABLE");
  }
}

function validateOrderSearchResult(
  order: NonNullable<Awaited<ReturnType<typeof findRefundOrderByReference>>>,
) {
  if (
    !ORDER_LINE_ID_PATTERN.test(order.id) ||
    !/^pi_[A-Za-z0-9]+$/.test(order.stripePaymentIntentId) ||
    !/^cs_(?:test_|live_)?[A-Za-z0-9]+$/.test(order.stripeCheckoutSessionId) ||
    order.status !== "paid" ||
    order.currency !== "eur" ||
    order.schemaVersion !== 1 ||
    !Number.isSafeInteger(order.amountTotal) ||
    order.amountTotal <= 0
  ) {
    throw new RefundRouteError(409, "ORDER_NOT_REFUNDABLE");
  }

  let computedTotal = 0;

  for (const line of order.lines) {
    if (
      !ORDER_LINE_ID_PATTERN.test(line.orderLineId) ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(line.catalogId) ||
      !Number.isInteger(line.sizeFr) ||
      line.sizeFr < 48 ||
      line.sizeFr > 70 ||
      !Number.isInteger(line.quantity) ||
      line.quantity < 1 ||
      !Number.isSafeInteger(line.unitAmount) ||
      line.unitAmount <= 0 ||
      !Number.isInteger(line.refundedQuantity) ||
      line.refundedQuantity < 0 ||
      !Number.isInteger(line.reservedRefundQuantity) ||
      line.reservedRefundQuantity < 0 ||
      line.refundedQuantity + line.reservedRefundQuantity > line.quantity
    ) {
      throw new RefundRouteError(409, "ORDER_LINE_NOT_REFUNDABLE");
    }

    computedTotal += line.quantity * line.unitAmount;
  }

  if (computedTotal !== order.amountTotal) {
    throw new RefundRouteError(409, "ORDER_AMOUNT_MISMATCH");
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

async function methodNotAllowed(request: Request) {
  const access = await verifyCloudflareAccess(request.headers);

  if (!access.ok) {
    return NextResponse.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 });
  }

  return NextResponse.json(
    { ok: false, error: "METHOD_NOT_ALLOWED" },
    { status: 405, headers: { Allow: "POST" } },
  );
}

export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const OPTIONS = methodNotAllowed;
export const HEAD = methodNotAllowed;

export async function POST(request: Request) {
  const access = await verifyCloudflareAccess(request.headers);

  if (!access.ok) {
    return NextResponse.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 });
  }

  const { env } = getCloudflareContext();
  const runtimeEnv = env as typeof env & { DB?: OrdersDatabase };

  if (!env.STRIPE_SECRET_KEY?.startsWith("sk_test_")) {
    return NextResponse.json({ ok: false, error: "REFUNDS_SANDBOX_ONLY" }, { status: 403 });
  }
  if (!hasTrustedAdminOrigin(request, env.STRIPE_SECRET_KEY)) {
    return NextResponse.json({ ok: false, error: "INVALID_REQUEST_ORIGIN" }, { status: 403 });
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return NextResponse.json({ ok: false, error: "JSON_CONTENT_TYPE_REQUIRED" }, { status: 415 });
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

  const parsedRequest = parseRefundRequest(body);

  if (!parsedRequest) {
    return NextResponse.json({ ok: false, error: "INVALID_REFUND_REQUEST" }, { status: 400 });
  }

  try {
    const db = runtimeEnv.DB;

    if (parsedRequest.action === "search") {
      const order = await findRefundOrderByReference(db, parsedRequest.reference);

      if (!order) {
        throw new RefundRouteError(404, "ORDER_NOT_FOUND");
      }

      validateOrderSearchResult(order);

      return NextResponse.json({
        ok: true,
        order: {
          id: order.id,
          stripe_payment_intent_id: order.stripePaymentIntentId,
          stripe_checkout_session_id: order.stripeCheckoutSessionId,
          amount_total: order.amountTotal,
          currency: order.currency,
          lines: order.lines.map((line) => {
            const refundableQuantity =
              line.quantity - line.refundedQuantity - line.reservedRefundQuantity;

            return {
              order_line_id: line.orderLineId,
              catalog_id: line.catalogId,
              product_name: CATALOG_NAMES[line.catalogId] ?? line.catalogId,
              size_fr: line.sizeFr,
              quantity: line.quantity,
              unit_amount: line.unitAmount,
              refunded_quantity: line.refundedQuantity,
              refundable_quantity: refundableQuantity,
              refundable_amount: refundableQuantity * line.unitAmount,
            };
          }),
        },
      });
    }

    const context = await getRefundContext(db, parsedRequest.orderLineId);

    if (!context) {
      throw new RefundRouteError(404, "ORDER_LINE_NOT_FOUND");
    }

    validateRefundableContext(context);

    const availableQuantity =
      context.quantity - context.refundedQuantity - context.reservedRefundQuantity;
    const refundableAmount = availableQuantity * context.unitAmount;

    if (parsedRequest.action === "preview") {
      return NextResponse.json({
        ok: true,
        preview: {
          order_line_id: context.orderLineId,
          catalog_id: context.catalogId,
          product_name: CATALOG_NAMES[context.catalogId] ?? context.catalogId,
          size_fr: context.sizeFr,
          unit_amount: context.unitAmount,
          available_quantity: availableQuantity,
          refundable_amount: refundableAmount,
          currency: context.currency,
        },
      });
    }

    if (parsedRequest.amount % context.unitAmount !== 0) {
      throw new RefundRouteError(409, "REFUND_AMOUNT_UNAVAILABLE");
    }

    const requestedQuantity = parsedRequest.amount / context.unitAmount;
    const existingOperation = await findRefundOperation(
      db,
      context.orderLineId,
      requestedQuantity,
    );

    if (!existingOperation && parsedRequest.amount > refundableAmount) {
      throw new RefundRouteError(409, "REFUND_AMOUNT_UNAVAILABLE");
    }

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
