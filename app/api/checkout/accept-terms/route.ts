import { getCloudflareContext } from "@opennextjs/cloudflare";
import { handleCheckoutTermsAcceptance } from "../../../services/checkout-elements-http";
import { createCheckoutStripeClient } from "../../../services/stripe-checkout-elements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const { env } = getCloudflareContext();
  if (!env.STRIPE_SECRET_KEY?.startsWith("sk_test_")) {
    return Response.json(
      { accepted: false },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  const stripeClient = createCheckoutStripeClient(env.STRIPE_SECRET_KEY);

  return handleCheckoutTermsAcceptance(request, {
    secretKey: env.STRIPE_SECRET_KEY,
    stripe: {
      retrieve: (id) => stripeClient.checkout.sessions.retrieve(id),
      listLineItems: (id) => stripeClient.checkout.sessions.listLineItems(id, { limit: 100 }),
      update: (id, params, options) => stripeClient.checkout.sessions.update(id, params, options),
    },
  });
}
