import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const catalog = {
  geometry: { name: "Geometry", amount: 25000 },
  "carved-cross": { name: "Karved Kross", amount: 20000 },
  "hollow-cross": { name: "Hollow Kross", amount: 20000 },
  "signet-corner": { name: "Signet Korner", amount: 20000 },
  "damaged-ring-i": { name: "Damaged Ring I", amount: 15000 },
  "damaged-ring-ii": { name: "Damaged Ring II", amount: 15000 },
} as const;

type CatalogId = keyof typeof catalog;
type CartItem = { id?: unknown; size?: unknown; quantity?: unknown };

export async function POST(request: Request) {
  const { env } = getCloudflareContext();

  if (!env.STRIPE_SECRET_KEY || !env.SITE_URL) {
    return NextResponse.json({ error: "Stripe runtime variables are not configured." }, { status: 503 });
  }

  let body: { items?: CartItem[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON request." }, { status: 400 });
  }

  if (!Array.isArray(body.items) || body.items.length === 0) {
    return NextResponse.json({ error: "Your kart is empty." }, { status: 400 });
  }

  const parameters = new URLSearchParams({
    mode: "payment",
    success_url: `${env.SITE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${env.SITE_URL}/checkout.html`,
  });

  for (const [index, item] of body.items.entries()) {
    const id = typeof item.id === "string" ? item.id : "";
    const product = catalog[id as CatalogId];
    const quantity = Number(item.quantity);
    const size = Number(item.size);

    if (!product || !Number.isInteger(quantity) || quantity < 1 || quantity > 5 || !Number.isInteger(size) || size < 48 || size > 70) {
      return NextResponse.json({ error: "One or more kart items are invalid." }, { status: 400 });
    }

    parameters.set(`line_items[${index}][price_data][currency]`, "eur");
    parameters.set(`line_items[${index}][price_data][product_data][name]`, `${product.name} — FR ${size}`);
    parameters.set(`line_items[${index}][price_data][unit_amount]`, String(product.amount));
    parameters.set(`line_items[${index}][quantity]`, String(quantity));
  }

  const stripeResponse = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: parameters,
  });
  const session = (await stripeResponse.json()) as { url?: string; error?: { message?: string } };

  if (!stripeResponse.ok || !session.url) {
    return NextResponse.json({ error: session.error?.message ?? "Stripe could not create a session." }, { status: stripeResponse.status });
  }

  return NextResponse.json({ url: session.url });
}
