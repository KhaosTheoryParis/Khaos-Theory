import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const encoder = new TextEncoder();

function parseSignature(header: string) {
  const parts = header.split(",").map((part) => part.split("="));
  return {
    timestamp: parts.find(([key]) => key === "t")?.[1],
    signatures: parts.filter(([key]) => key === "v1").map(([, value]) => value),
  };
}

function safeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

async function verifyStripeSignature(payload: string, header: string, secret: string) {
  const { timestamp, signatures } = parseSignature(header);
  if (!timestamp || signatures.length === 0) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${payload}`));
  const expected = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return signatures.some((signature) => safeEqual(signature, expected));
}

export async function POST(request: Request) {
  const { env } = getCloudflareContext();
  const signature = request.headers.get("stripe-signature");
  const payload = await request.text();

  if (!env.STRIPE_WEBHOOK_SECRET || !signature || !(await verifyStripeSignature(payload, signature, env.STRIPE_WEBHOOK_SECRET))) {
    return NextResponse.json({ error: "Invalid Stripe signature." }, { status: 400 });
  }

  const event = JSON.parse(payload) as { id: string; type: string };

  if (event.type === "checkout.session.completed") {
    console.log(`Stripe checkout completed: ${event.id}`);
  }

  return NextResponse.json({ received: true });
}
