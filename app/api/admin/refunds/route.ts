import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextResponse } from "next/server";
import Stripe from "stripe";
import {
  parseAdminRefundRequest,
} from "../../../services/admin-refund-command";
import {
  AdminRefundShippingError,
  adminRefundShippingSummary,
  resolveAdminShippingRefundAmount,
} from "../../../services/admin-refund-shipping";
import {
  createAdminRefundStripeClient,
  createAdminStripeRefund,
  traceAdminRefundStep,
} from "../../../services/admin-refund-stripe";
import { verifyCloudflareAccess } from "../../../services/cloudflare-access";
import type { OrdersDatabase } from "../../../services/orders";
import {
  attachStripeRefundToOperation,
  assertRefundOperationMatches,
  assertShippingOnlyOperationMatches,
  failRefundOperation,
  failRefundOperationBeforeStripe,
  finalizeRefundOperation,
  findRefundOperation,
  findRefundOrderByReference,
  getRefundContexts,
  getRefundShippingContext,
  getRefundPersistenceErrorDetails,
  reserveRefundOperationLines,
  reserveShippingRefundOperation,
  type RefundContext,
  type RefundOperation,
  type RefundSelection,
  type RefundShippingContext,
} from "../../../services/refunds";
import { resolveCheckoutShipping } from "../../../services/stripe-checkout-shipping";

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

const CATALOG_NAMES: Record<string, string> = {
  geometry: "Geometry",
  "carved-cross": "Karved Kross",
  "hollow-cross": "Hollow Kross",
  "signet-corner": "Signet Korner",
  "damaged-ring-i": "Damaged Ring I",
  "damaged-ring-ii": "Damaged Ring II",
};

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

  adminRefundShippingSummary(order);
  if (order.shippingAmount === null) {
    if (order.productsSubtotal !== null || order.shippingCountry !== null || order.shippingZone !== null ||
      computedTotal !== order.amountTotal) {
      throw new RefundRouteError(409, "ORDER_AMOUNT_MISMATCH");
    }
    return;
  }
  if (order.productsSubtotal !== computedTotal || order.shippingCountry !== "FR" ||
    order.shippingZone !== "FR" || computedTotal + order.shippingAmount !== order.amountTotal) {
    throw new RefundRouteError(409, "ORDER_AMOUNT_MISMATCH");
  }
}

function validateRefundableOrder(context: RefundShippingContext) {
  if (context.orderStatus !== "paid") throw new RefundRouteError(409, "ORDER_NOT_PAID");
  if (context.currency !== "eur") throw new RefundRouteError(409, "ORDER_CURRENCY_NOT_SUPPORTED");
  if (context.schemaVersion !== 1) throw new RefundRouteError(409, "ORDER_SCHEMA_NOT_SUPPORTED");
  if (!Number.isSafeInteger(context.amountTotal) || context.amountTotal <= 0 ||
    !/^cs_(?:test_|live_)?[A-Za-z0-9]+$/.test(context.stripeCheckoutSessionId) ||
    !/^pi_[A-Za-z0-9]+$/.test(context.stripePaymentIntentId)) {
    throw new RefundRouteError(409, "ORDER_STRIPE_REFERENCES_INVALID");
  }
  adminRefundShippingSummary(context);
  if (context.shippingAmount === null) {
    if (context.productsSubtotal !== null || context.shippingCountry !== null || context.shippingZone !== null) {
      throw new RefundRouteError(409, "INVALID_SHIPPING_REFUND_STATE");
    }
  } else if (!Number.isSafeInteger(context.productsSubtotal) || context.productsSubtotal! < 0 ||
    context.shippingCountry !== "FR" || context.shippingZone !== "FR" ||
    context.productsSubtotal! + context.shippingAmount !== context.amountTotal) {
    throw new RefundRouteError(409, "INVALID_SHIPPING_REFUND_STATE");
  }
}

function validateSelectedContexts(
  contexts: RefundContext[],
  selections: RefundSelection[],
  orderContext: RefundShippingContext,
  requireAvailable = true,
) {
  if (contexts.length !== selections.length) {
    throw new RefundRouteError(409, "REFUND_LINES_MISMATCH");
  }
  const selectionsById = new Map(selections.map((line) => [line.orderLineId, line]));
  for (const context of contexts) {
    validateRefundableContext(context);
    const selection = selectionsById.get(context.orderLineId);
    if (!selection || context.orderId !== orderContext.orderId ||
      context.stripeCheckoutSessionId !== orderContext.stripeCheckoutSessionId ||
      context.stripePaymentIntentId !== orderContext.stripePaymentIntentId ||
      context.amountTotal !== orderContext.amountTotal || context.currency !== orderContext.currency) {
      throw new RefundRouteError(409, "REFUND_LINES_ORDER_MISMATCH");
    }
    if (requireAvailable) validateD1Context(context, selection.requestedQuantity);
  }
}

async function validateStripeOrder(
  stripe: Stripe,
  contexts: RefundContext[],
  context: RefundShippingContext,
): Promise<ValidatedStripeOrder> {
  const paymentIntent = await traceAdminRefundStep(
    "stripe.paymentIntents.retrieve",
    () => stripe.paymentIntents.retrieve(context.stripePaymentIntentId),
  );

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
  const charge = await traceAdminRefundStep(
    "stripe.charges.retrieve",
    () => stripe.charges.retrieve(chargeId),
  );

  if (
    charge.id !== chargeId ||
    charge.paid !== true ||
    charge.currency !== "eur" ||
    charge.amount !== context.amountTotal ||
    requirePaymentIntentId(charge.payment_intent) !== context.stripePaymentIntentId
  ) {
    throw new RefundRouteError(409, "STRIPE_CHARGE_ORDER_MISMATCH");
  }

  const session = await traceAdminRefundStep(
    "stripe.checkout.sessions.retrieve",
    () => stripe.checkout.sessions.retrieve(context.stripeCheckoutSessionId),
  );

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

  const lineItems = await traceAdminRefundStep(
    "stripe.checkout.sessions.listLineItems",
    () =>
      stripe.checkout.sessions
        .listLineItems(session.id, { limit: 100 })
        .autoPagingToArray({ limit: 1_000 }),
  );
  for (const selectedContext of contexts) {
    const lineItem = lineItems.find((item) => item.id === selectedContext.stripeLineItemId);
    if (!lineItem || lineItem.metadata?.order_line_id !== selectedContext.orderLineId ||
      lineItem.metadata?.catalog_id !== selectedContext.catalogId ||
      lineItem.metadata?.size_fr !== String(selectedContext.sizeFr) ||
      lineItem.metadata?.schema_version !== "1" || lineItem.currency !== "eur" ||
      lineItem.quantity !== selectedContext.quantity ||
      lineItem.amount_total !== selectedContext.quantity * selectedContext.unitAmount ||
      lineItem.amount_discount !== 0 || lineItem.amount_tax !== 0) {
      throw new RefundRouteError(409, "STRIPE_LINE_ITEM_ORDER_MISMATCH");
    }
  }

  if (context.shippingAmount !== null) {
    let shipping;
    try {
      shipping = resolveCheckoutShipping(session, context.productsSubtotal!);
    } catch {
      throw new RefundRouteError(409, "STRIPE_SHIPPING_ORDER_MISMATCH");
    }
    if (!shipping || shipping.shippingAmount !== context.shippingAmount ||
      shipping.shippingCountry !== context.shippingCountry || shipping.shippingZone !== context.shippingZone) {
      throw new RefundRouteError(409, "STRIPE_SHIPPING_ORDER_MISMATCH");
    }
  }

  return { charge };
}

function refundMetadata(context: RefundShippingContext, operation: RefundOperation) {
  return {
    checkout_session_id: context.stripeCheckoutSessionId,
    order_id: context.orderId,
    schema_version: "3",
    refund_operation_id: operation.id,
  };
}

function validateStripeRefund(
  refund: Stripe.Refund,
  context: RefundShippingContext,
  operation: RefundOperation,
) {
  const expectedMetadata = refundMetadata(context, operation);

  if (
    !/^re_[A-Za-z0-9]+$/.test(refund.id) ||
    refund.amount !== operation.amount ||
    refund.currency !== "eur" ||
    requirePaymentIntentId(refund.payment_intent) !== context.stripePaymentIntentId ||
    Object.entries(expectedMetadata).some(([key, value]) => refund.metadata?.[key] !== value)
  ) {
    throw new RefundRouteError(409, "STRIPE_REFUND_MISMATCH");
  }

  return refund;
}

function isPermanentStripeCreationError(error: unknown) {
  if (!(error instanceof Stripe.errors.StripeError)) return false;

  const status = error.statusCode;
  return (
    typeof status === "number" &&
    status >= 400 &&
    status < 500 &&
    ![408, 409, 425, 429].includes(status)
  );
}

async function findStripeRefundForPendingOperation(
  stripe: Stripe,
  context: RefundShippingContext,
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
  if (error instanceof AdminRefundShippingError) {
    return NextResponse.json({ ok: false, error: error.code }, { status: 409 });
  }
  if (error instanceof RefundRouteError) {
    return NextResponse.json({ ok: false, error: error.code }, { status: error.status });
  }

  const persistenceError = getRefundPersistenceErrorDetails(error);

  if (persistenceError.code !== "UNEXPECTED_REFUND_PERSISTENCE_ERROR") {
    const status =
      persistenceError.code === "ORDER_LINE_NOT_FOUND"
        ? 404
        : persistenceError.code.includes("QUANTITY") || persistenceError.code.includes("CONFLICT") ||
            persistenceError.code.includes("SHIPPING_REFUND_AMOUNT_UNAVAILABLE")
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

  const parsedRequest = parseAdminRefundRequest(body);

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
      const shipping = adminRefundShippingSummary(order);

      return NextResponse.json({
        ok: true,
        order: {
          id: order.id,
          stripe_payment_intent_id: order.stripePaymentIntentId,
          stripe_checkout_session_id: order.stripeCheckoutSessionId,
          amount_total: order.amountTotal,
          currency: order.currency,
          shipping: shipping ? {
            label: shipping.label,
            amount: shipping.amount,
            refunded_amount: shipping.refundedAmount,
            reserved_amount: shipping.reservedAmount,
            refundable_amount: shipping.refundableAmount,
          } : null,
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

    const contexts = parsedRequest.lines.length > 0
      ? await getRefundContexts(db, parsedRequest.lines.map((line) => line.orderLineId))
      : [];
    const orderId = parsedRequest.orderId ?? contexts[0]?.orderId ?? null;
    if (!orderId) throw new RefundRouteError(404, "ORDER_NOT_FOUND");
    const orderContext = await getRefundShippingContext(db, orderId);
    if (!orderContext) throw new RefundRouteError(404, "ORDER_NOT_FOUND");
    validateRefundableOrder(orderContext);
    const existingOperation = parsedRequest.action === "refund"
      ? await findRefundOperation(db, parsedRequest.operationId)
      : null;
    validateSelectedContexts(contexts, parsedRequest.lines, orderContext, !existingOperation);
    const shippingRefundAmount = existingOperation?.shippingRefundAmount ??
      resolveAdminShippingRefundAmount(orderContext, parsedRequest.refundShipping);
    if (existingOperation) {
      if (existingOperation.orderId !== orderContext.orderId ||
        (shippingRefundAmount > 0) !== parsedRequest.refundShipping) {
        throw new RefundRouteError(409, "REFUND_OPERATION_CONFLICT");
      }
      if (contexts.length > 0) {
        assertRefundOperationMatches(existingOperation, contexts, parsedRequest.lines, shippingRefundAmount);
      } else {
        assertShippingOnlyOperationMatches(existingOperation, orderContext, shippingRefundAmount);
      }
    }
    const contextsById = new Map(contexts.map((context) => [context.orderLineId, context]));
    const requestedAmount = parsedRequest.lines.reduce((total, line) => {
      const context = contextsById.get(line.orderLineId);
      if (!context) throw new RefundRouteError(404, "ORDER_LINE_NOT_FOUND");
      return total + context.unitAmount * line.requestedQuantity;
    }, shippingRefundAmount);

    if (parsedRequest.action === "preview") {
      return NextResponse.json({
        ok: true,
        preview: {
          refund_operation_id: crypto.randomUUID(),
          order_id: orderContext.orderId,
          amount: requestedAmount,
          currency: orderContext.currency,
          shipping: shippingRefundAmount > 0 ? {
            label: "Livraison sécurisée / Secure shipping",
            amount: shippingRefundAmount,
          } : null,
          lines: parsedRequest.lines.map((selection) => {
            const selectedContext = contextsById.get(selection.orderLineId)!;
            return {
              order_line_id: selectedContext.orderLineId,
              catalog_id: selectedContext.catalogId,
              product_name: CATALOG_NAMES[selectedContext.catalogId] ?? selectedContext.catalogId,
              size_fr: selectedContext.sizeFr,
              unit_amount: selectedContext.unitAmount,
              requested_quantity: selection.requestedQuantity,
              amount: selectedContext.unitAmount * selection.requestedQuantity,
            };
          }),
        },
      });
    }
    if (existingOperation?.status === "failed") {
      throw new RefundRouteError(409, "REFUND_OPERATION_FAILED");
    }

    const stripe = stripeForRefund(env.STRIPE_SECRET_KEY);
    const { charge } = await validateStripeOrder(stripe, contexts, orderContext);

    if (existingOperation?.status === "succeeded" && existingOperation.stripeRefundId) {
      const refund = validateStripeRefund(
        await stripe.refunds.retrieve(existingOperation.stripeRefundId),
        orderContext,
        existingOperation,
      );

      return NextResponse.json({
        ok: true,
        refund_id: refund.id,
        amount: refund.amount,
        currency: refund.currency,
      });
    }

    const reservation = await traceAdminRefundStep("d1.reserveRefundOperation", () =>
      contexts.length > 0
        ? reserveRefundOperationLines(
          db, contexts, parsedRequest.lines, parsedRequest.operationId, shippingRefundAmount,
        )
        : reserveShippingRefundOperation(
          db, orderContext.orderId, shippingRefundAmount, parsedRequest.operationId,
        ));
    const operation = reservation.operation;

    if (reservation.created && charge.amount_refunded + operation.amount > charge.amount) {
      await failRefundOperationBeforeStripe(db, operation, "STRIPE_REFUND_AMOUNT_UNAVAILABLE");
      throw new RefundRouteError(409, "STRIPE_REFUND_AMOUNT_UNAVAILABLE");
    }

    let refund = await findStripeRefundForPendingOperation(stripe, orderContext, operation);

    if (!refund) {
      try {
        refund = validateStripeRefund(
          await createAdminStripeRefund(stripe, {
            paymentIntentId: orderContext.stripePaymentIntentId,
            amount: operation.amount,
            metadata: refundMetadata(orderContext, operation),
            idempotencyKey: operation.stripeIdempotencyKey,
          }),
          orderContext,
          operation,
        );
      } catch (error) {
        // A known permanent Stripe 4xx means no Refund was created. Release the
        // reservation atomically. Network/429/5xx failures keep it reserved so a
        // retry with the same operation ID and Stripe idempotency key stays safe.
        if (isPermanentStripeCreationError(error)) {
          await failRefundOperationBeforeStripe(
            db,
            operation,
            "STRIPE_REFUND_CREATION_PERMANENT_FAILURE",
          );
        }
        throw error;
      }
    }

    await attachStripeRefundToOperation(db, operation, refund.id);

    if (refund.status === "failed" || refund.status === "canceled") {
      await failRefundOperation(
        db,
        operation,
        refund.id,
        `STRIPE_REFUND_${refund.status.toUpperCase()}`,
      );
      throw new RefundRouteError(409, "STRIPE_REFUND_FAILED");
    }

    if (refund.status === "succeeded") {
      try {
        await finalizeRefundOperation(db, operation, refund.id);
      } catch (error) {
        console.error("REFUND_D1_FINALIZATION_ERROR", {
          refund_operation_id: operation.id,
          stripe_refund_id: refund.id,
          order_line_ids: operation.lines.map((line) => line.orderLineId),
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
      order_line_ids: operation.lines.map((line) => line.orderLineId),
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
  return createAdminRefundStripeClient(secretKey);
}
