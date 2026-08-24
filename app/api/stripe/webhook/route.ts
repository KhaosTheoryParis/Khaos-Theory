import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextResponse } from "next/server";
import Stripe from "stripe";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const { env } = getCloudflareContext();
  const signature = req.headers.get("stripe-signature");
  const payload = await req.text();

  if (!signature || !env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Missing Stripe signature or configuration." }, { status: 400 });
  }

  const stripe = new Stripe(env.STRIPE_SECRET_KEY);

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(payload, signature, env.STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    console.error(
      "Stripe webhook signature verification failed:",
      error instanceof Error ? error.message : "Unknown error",
    );

    return NextResponse.json({ error: "Invalid Stripe signature." }, { status: 400 });
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;

      if (session.payment_status === "paid") {
        console.log("PAYMENT_SUCCEEDED", {
          session_id: session.id,
          payment_intent:
            typeof session.payment_intent === "string"
              ? session.payment_intent
              : (session.payment_intent?.id ?? null),
          amount_total: session.amount_total,
          currency: session.currency,
          customer_email: session.customer_details?.email ?? session.customer_email ?? null,
        });
      } else {
        console.log("CHECKOUT_COMPLETED_NOT_PAID", {
          session_id: session.id,
          payment_status: session.payment_status,
        });
      }
      break;
    }

    case "payment_intent.payment_failed": {
      const paymentIntent = event.data.object;

      console.error("PAYMENT_FAILED", {
        payment_intent_id: paymentIntent.id,
        amount: paymentIntent.amount,
        currency: paymentIntent.currency,
        error_message: paymentIntent.last_payment_error?.message ?? null,
      });
      break;
    }

    case "checkout.session.expired": {
      const session = event.data.object;

      console.log("CHECKOUT_EXPIRED", { session_id: session.id });
      break;
    }

    case "charge.refunded": {
      const charge = event.data.object;

      console.log("PAYMENT_REFUNDED", {
        charge_id: charge.id,
        payment_intent:
          typeof charge.payment_intent === "string"
            ? charge.payment_intent
            : (charge.payment_intent?.id ?? null),
        amount_refunded: charge.amount_refunded,
        currency: charge.currency,
      });
      break;
    }

    default:
      break;
  }

  return NextResponse.json({ received: true }, { status: 200 });
}
