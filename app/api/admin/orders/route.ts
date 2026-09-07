import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextResponse } from "next/server";
import Stripe from "stripe";
import { createAdminOrdersGetHandler } from "../../../services/admin-orders";
import { verifyCloudflareAccess } from "../../../services/cloudflare-access";
import type { OrdersDatabase } from "../../../services/orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const getAdminOrders = createAdminOrdersGetHandler({
  verifyAccess: verifyCloudflareAccess,
  getDatabase() {
    const { env } = getCloudflareContext();
    return (env as typeof env & { DB?: OrdersDatabase }).DB;
  },
  async retrieveCheckoutSession(sessionId) {
    const { env } = getCloudflareContext();
    const secretKey = (env as typeof env & { STRIPE_SECRET_KEY?: string }).STRIPE_SECRET_KEY;
    if (!secretKey) throw new Error("MISSING_STRIPE_SECRET_KEY");
    const stripe = new Stripe(secretKey, {
      timeout: 10_000,
      maxNetworkRetries: 0,
      httpClient: Stripe.createFetchHttpClient(),
    });
    return stripe.checkout.sessions.retrieve(sessionId);
  },
});

export function GET(request: Request) {
  return getAdminOrders(request);
}

async function methodNotAllowed(request: Request) {
  const access = await verifyCloudflareAccess(request.headers);
  if (!access.ok) {
    return NextResponse.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 });
  }
  return NextResponse.json(
    { ok: false, error: "METHOD_NOT_ALLOWED" },
    { status: 405, headers: { Allow: "GET" } },
  );
}

export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const OPTIONS = methodNotAllowed;
export const HEAD = methodNotAllowed;
