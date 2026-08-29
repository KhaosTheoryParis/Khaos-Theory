import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextResponse } from "next/server";
import { createAdminRefundAnalyticsGetHandler } from "../../../../services/admin-refund-analytics";
import { verifyCloudflareAccess } from "../../../../services/cloudflare-access";
import type { OrdersDatabase } from "../../../../services/orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const getAdminRefundAnalytics = createAdminRefundAnalyticsGetHandler({
  verifyAccess: verifyCloudflareAccess,
  getDatabase() {
    const { env } = getCloudflareContext();
    return (env as typeof env & { DB?: OrdersDatabase }).DB;
  },
});

export function GET(request: Request) {
  return getAdminRefundAnalytics(request);
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
