import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  handleCreateCheckoutSession,
  type CheckoutRuntime,
} from "../../services/checkout-elements-http";
import { createCheckoutStripeClient } from "../../services/stripe-checkout-elements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const { env } = getCloudflareContext();
  const runtimeEnv = env as typeof env & CheckoutRuntime;
  if (!runtimeEnv.STRIPE_SECRET_KEY?.startsWith("sk_test_")) {
    return Response.json(
      { error: "Stripe runtime variables are not configured." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  const stripeClient = createCheckoutStripeClient(runtimeEnv.STRIPE_SECRET_KEY);

  return handleCreateCheckoutSession(request, {
    env: runtimeEnv,
    stripe: {
      create: (params) => stripeClient.checkout.sessions.create(params),
    },
  });
}
