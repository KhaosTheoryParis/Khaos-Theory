import { NextResponse } from "next/server";
import { validateFrShippingDestination } from "../../../services/fr-shipping-destination";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_REQUEST_BYTES = 2_048;
const DESTINATION_KEYS = ["city", "country", "postalCode"] as const;

type DestinationRequestBody = {
  country: string;
  postalCode: string;
  city: string;
};

export async function POST(request: Request) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return eligibilityResponse(false, 415);
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength && /^\d+$/u.test(contentLength) && Number(contentLength) > MAX_REQUEST_BYTES) {
    return eligibilityResponse(false, 413);
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return eligibilityResponse(false, 400);
  }

  if (new TextEncoder().encode(rawBody).byteLength > MAX_REQUEST_BYTES) {
    return eligibilityResponse(false, 413);
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody) as unknown;
  } catch {
    return eligibilityResponse(false, 400);
  }

  if (!isDestinationRequestBody(body)) {
    return eligibilityResponse(false, 400);
  }

  const validation = validateFrShippingDestination(body);
  return eligibilityResponse(validation.eligible, validation.eligible ? 200 : 422);
}

function isDestinationRequestBody(value: unknown): value is DestinationRequestBody {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== DESTINATION_KEYS.length ||
    keys.some((key, index) => key !== DESTINATION_KEYS[index])
  ) {
    return false;
  }

  return (
    typeof record.country === "string" &&
    typeof record.postalCode === "string" &&
    typeof record.city === "string"
  );
}

function eligibilityResponse(eligible: boolean, status: number) {
  return NextResponse.json(
    { eligible },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
