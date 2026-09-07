import type Stripe from "stripe";

export const CURRENT_TERMS_VERSION = "2026-09" as const;

export type CheckoutTermsAcceptance = {
  termsVersion: typeof CURRENT_TERMS_VERSION;
  termsAcceptedAt: string;
};

export function readCheckoutTermsAcceptance(
  session: Pick<Stripe.Checkout.Session, "metadata">,
): CheckoutTermsAcceptance | null {
  const requiredVersion = session.metadata?.terms_required;
  if (requiredVersion === undefined) return null;

  const termsVersion = session.metadata?.terms_version;
  const termsAcceptedAt = session.metadata?.terms_accepted_at;
  if (
    requiredVersion !== CURRENT_TERMS_VERSION ||
    termsVersion !== CURRENT_TERMS_VERSION ||
    !isCanonicalUtcTimestamp(termsAcceptedAt)
  ) {
    throw new Error("CHECKOUT_TERMS_ACCEPTANCE_REQUIRED");
  }

  return { termsVersion, termsAcceptedAt };
}

export function isCanonicalUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !value.endsWith("Z")) return false;
  const timestamp = Date.parse(value);
  return !Number.isNaN(timestamp) && new Date(timestamp).toISOString() === value;
}
