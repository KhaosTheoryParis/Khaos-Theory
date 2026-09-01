import { NextResponse } from "next/server";
import { validateFrShippingDestination } from "../../../services/fr-shipping-destination";
import { quoteShipping } from "../../../services/shipping";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_REQUEST_BYTES = 2_048;
const QUOTE_KEYS = ["city", "country", "postalCode", "productsSubtotal"] as const;

type ShippingQuoteRequestBody = {
  country: string;
  postalCode: string;
  city: string;
  productsSubtotal: number;
};

/**
 * Informational quote only. The browser-provided subtotal is never payment authority:
 * create-checkout-session must independently rebuild the product subtotal from its
 * server-side catalog before any future shipping option or payment is created.
 */
export async function POST(request: Request) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return ineligibleResponse(415);
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength && /^\d+$/u.test(contentLength) && Number(contentLength) > MAX_REQUEST_BYTES) {
    return ineligibleResponse(413);
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return ineligibleResponse(400);
  }

  if (new TextEncoder().encode(rawBody).byteLength > MAX_REQUEST_BYTES) {
    return ineligibleResponse(413);
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody) as unknown;
  } catch {
    return ineligibleResponse(400);
  }

  if (!isShippingQuoteRequestBody(body)) {
    return ineligibleResponse(400);
  }

  const destination = validateFrShippingDestination(body);
  if (!destination.eligible) {
    return ineligibleResponse(422);
  }

  // The locale affects only an unused display label; all V1 amounts come from shipping.ts.
  const quote = quoteShipping(body.productsSubtotal, "fr");

  return NextResponse.json(
    {
      eligible: true,
      currency: quote.currency,
      productsSubtotal: body.productsSubtotal,
      shippingAmount: quote.shippingAmount,
      totalAmount: quote.amountTotal,
      shippingCountry: quote.shippingCountry,
      shippingZone: quote.shippingZone,
    },
    {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

function isShippingQuoteRequestBody(value: unknown): value is ShippingQuoteRequestBody {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== QUOTE_KEYS.length || keys.some((key, index) => key !== QUOTE_KEYS[index])) {
    return false;
  }

  return (
    typeof record.country === "string" &&
    typeof record.postalCode === "string" &&
    typeof record.city === "string" &&
    typeof record.productsSubtotal === "number" &&
    Number.isSafeInteger(record.productsSubtotal) &&
    record.productsSubtotal >= 0
  );
}

function ineligibleResponse(status: number) {
  return NextResponse.json(
    { eligible: false },
    {
      status,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
