import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const PENNYLANE_CUSTOMERS_URL = "https://app.pennylane.com/api/external/v2/customers?limit=1";

export async function GET() {
  const { env } = getCloudflareContext();
  const token = (env as typeof env & { PENNYLANE_API_TOKEN?: string }).PENNYLANE_API_TOKEN;

  if (!token) {
    return NextResponse.json(
      { ok: false, status: 503, error: "Pennylane API configuration is missing." },
      { status: 503 },
    );
  }

  try {
    const response = await fetch(PENNYLANE_CUSTOMERS_URL, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      cache: "no-store",
    });

    if (response.ok) {
      return NextResponse.json({ ok: true, status: response.status }, { status: 200 });
    }

    const error =
      response.status === 401 || response.status === 403
        ? "Pennylane authentication or authorization failed."
        : "Pennylane API request failed.";

    return NextResponse.json(
      { ok: false, status: response.status, error },
      { status: response.status },
    );
  } catch {
    return NextResponse.json(
      { ok: false, status: 502, error: "Pennylane API is unreachable." },
      { status: 502 },
    );
  }
}
