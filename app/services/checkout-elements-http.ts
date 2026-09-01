import type Stripe from "stripe";
import { resolveCheckoutLocale } from "./checkout-locale";
import {
  CheckoutElementsError,
  checkoutElementsSessionParams,
  prepareCheckoutElementsCart,
  updateCheckoutShipping,
  parseCheckoutShippingUpdateBody,
  type CreateCheckoutSessionPort,
  type UpdateCheckoutSessionPort,
} from "./stripe-checkout-elements";

const MAX_CREATE_REQUEST_BYTES = 32_768;
const MAX_UPDATE_REQUEST_BYTES = 4_096;
const CHECKOUT_KEYS = ["items", "locale"] as const;

export type CheckoutRuntime = {
  STRIPE_SECRET_KEY?: string;
  STRIPE_PUBLISHABLE_KEY?: string;
  SITE_URL?: string;
};

export type CreateCheckoutDependencies = {
  env: CheckoutRuntime;
  stripe: CreateCheckoutSessionPort;
  randomUUID?: () => string;
};

export type UpdateShippingDependencies = {
  secretKey: string;
  stripe: UpdateCheckoutSessionPort;
};

export async function handleCreateCheckoutSession(
  request: Request,
  dependencies: CreateCheckoutDependencies,
) {
  const { env } = dependencies;
  if (
    !env.STRIPE_SECRET_KEY?.startsWith("sk_test_") ||
    !env.STRIPE_PUBLISHABLE_KEY?.startsWith("pk_test_") ||
    !env.SITE_URL
  ) {
    return json({ error: "Stripe runtime variables are not configured." }, 503);
  }

  const parsedBody = await readStrictJson(request, MAX_CREATE_REQUEST_BYTES);
  if (!parsedBody.ok) return json({ error: parsedBody.error }, parsedBody.status);
  if (!isCheckoutRequestBody(parsedBody.body)) {
    return json({ error: "Invalid checkout request." }, 400);
  }

  const localeResult = resolveCheckoutLocale(parsedBody.body);
  if (!localeResult.ok) {
    return json({ error: "Invalid checkout locale." }, 400);
  }

  const cart = prepareCheckoutElementsCart(parsedBody.body.items, dependencies.randomUUID);
  if (!cart) {
    return json({ error: "One or more kart items are invalid." }, 400);
  }

  const params = checkoutElementsSessionParams(cart, localeResult.locale, env.SITE_URL);
  let session: Stripe.Checkout.Session;
  try {
    session = await dependencies.stripe.create(params);
  } catch {
    return json({ error: "Stripe could not create a session." }, 502);
  }

  if (
    !session.id.startsWith("cs_test_") ||
    session.livemode !== false ||
    session.ui_mode !== "elements" ||
    session.mode !== "payment" ||
    session.status !== "open" ||
    session.payment_status !== "unpaid" ||
    session.currency !== "eur" ||
    session.amount_subtotal !== cart.productsSubtotal ||
    typeof session.client_secret !== "string" ||
    !session.client_secret.startsWith(`${session.id}_secret_`)
  ) {
    return json({ error: "Stripe returned an invalid session." }, 502);
  }

  return json({
    checkoutSessionId: session.id,
    clientSecret: session.client_secret,
    publishableKey: env.STRIPE_PUBLISHABLE_KEY,
  }, 200);
}

export async function handleCheckoutShippingUpdate(
  request: Request,
  dependencies: UpdateShippingDependencies,
) {
  if (!dependencies.secretKey.startsWith("sk_test_")) {
    return updatedResponse(false, 503);
  }

  const parsedBody = await readStrictJson(request, MAX_UPDATE_REQUEST_BYTES);
  if (!parsedBody.ok) return updatedResponse(false, parsedBody.status);
  const body = parseCheckoutShippingUpdateBody(parsedBody.body);
  if (!body) return updatedResponse(false, 400);

  try {
    const result = await updateCheckoutShipping({ body, stripe: dependencies.stripe });
    return Response.json(
      {
        updated: true,
        shippingAmount: result.shippingAmount,
        amountTotal: result.amountTotal,
        currency: result.currency,
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof CheckoutElementsError) {
      return updatedResponse(false, error.status);
    }
    return updatedResponse(false, 500);
  }
}

function isCheckoutRequestBody(value: unknown): value is { items: unknown; locale?: unknown } {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  if (!keys.includes("items") || keys.some((key) => !CHECKOUT_KEYS.includes(key as typeof CHECKOUT_KEYS[number]))) {
    return false;
  }
  return keys.length === 1 || (keys.length === 2 && keys[0] === "items" && keys[1] === "locale");
}

async function readStrictJson(request: Request, maxBytes: number): Promise<
  | { ok: true; body: unknown }
  | { ok: false; status: number; error: string }
> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return { ok: false, status: 415, error: "JSON content type required." };
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength && /^\d+$/u.test(contentLength) && Number(contentLength) > maxBytes) {
    return { ok: false, status: 413, error: "Request is too large." };
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return { ok: false, status: 400, error: "Invalid JSON request." };
  }
  if (new TextEncoder().encode(rawBody).byteLength > maxBytes) {
    return { ok: false, status: 413, error: "Request is too large." };
  }

  try {
    return { ok: true, body: JSON.parse(rawBody) as unknown };
  } catch {
    return { ok: false, status: 400, error: "Invalid JSON request." };
  }
}

function json(body: object, status: number) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function updatedResponse(updated: boolean, status: number) {
  return Response.json(
    { updated },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
