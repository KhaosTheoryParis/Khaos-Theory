import type Stripe from "stripe";
import type { PersistedOrderShippingInput } from "./orders";

function requireNonNegativeInteger(value: number | null, code: string) {
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(code);
  return value as number;
}

/**
 * Normalizes shipping data from Stripe Checkout SDK 22.5.0. The product subtotal
 * supplied here must already have been validated from Stripe product line items.
 */
export function resolveCheckoutShipping(
  session: Stripe.Checkout.Session,
  productsSubtotalFromLines: number,
): PersistedOrderShippingInput | null {
  const amountShipping = session.total_details?.amount_shipping ?? null;
  const shippingCountry =
    session.collected_information?.shipping_details?.address.country ?? null;
  const hasShipping =
    session.shipping_cost !== null ||
    (amountShipping !== null && amountShipping !== 0) ||
    shippingCountry !== null;

  if (!hasShipping) return null;

  const productsSubtotal = requireNonNegativeInteger(
    productsSubtotalFromLines,
    "INVALID_STRIPE_PRODUCTS_SUBTOTAL",
  );
  const sessionProductsSubtotal = requireNonNegativeInteger(
    session.amount_subtotal,
    "INVALID_STRIPE_SESSION_SUBTOTAL",
  );
  if (!session.shipping_cost) throw new Error("MISSING_STRIPE_SHIPPING_COST");

  const shippingAmount = requireNonNegativeInteger(
    session.shipping_cost.amount_total,
    "INVALID_STRIPE_SHIPPING_AMOUNT",
  );
  const amountTotal = requireNonNegativeInteger(
    session.amount_total,
    "INVALID_STRIPE_SESSION_TOTAL",
  );
  const shippingSubtotal = requireNonNegativeInteger(
    session.shipping_cost.amount_subtotal,
    "INVALID_STRIPE_SHIPPING_SUBTOTAL",
  );
  const shippingTax = requireNonNegativeInteger(
    session.shipping_cost.amount_tax,
    "INVALID_STRIPE_SHIPPING_TAX",
  );
  const totalDetailsShipping = requireNonNegativeInteger(
    amountShipping,
    "INVALID_STRIPE_TOTAL_DETAILS_SHIPPING",
  );

  if (
    sessionProductsSubtotal !== productsSubtotal ||
    shippingSubtotal !== shippingAmount ||
    shippingTax !== 0 ||
    totalDetailsShipping !== shippingAmount ||
    session.total_details?.amount_discount !== 0 ||
    session.total_details.amount_tax !== 0 ||
    productsSubtotal + shippingAmount !== amountTotal
  ) {
    throw new Error("STRIPE_SHIPPING_TOTAL_MISMATCH");
  }
  if (shippingCountry !== "FR") throw new Error("UNSUPPORTED_SHIPPING_COUNTRY");

  return {
    productsSubtotal,
    shippingAmount,
    shippingCountry: "FR",
    shippingZone: "FR",
  };
}
