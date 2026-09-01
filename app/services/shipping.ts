import { isLocale, type Locale } from "../i18n/config";

/** All monetary amounts in this module are integer euro cents. */
export const FREE_SHIPPING_THRESHOLD = 40_000;
export const FR_SHIPPING_AMOUNT = 1_000;

/**
 * Known future shipping zones. SHIPPING V1 activates FR only; it deliberately
 * provides neither a WORLD zone nor a fallback for an unsupported destination.
 */
export const KNOWN_SHIPPING_ZONES = ["FR", "EU", "JP", "KR"] as const;
export type ShippingZone = (typeof KNOWN_SHIPPING_ZONES)[number];

export type ShippingQuote = {
  shippingCountry: "FR";
  shippingZone: "FR";
  shippingAmount: number;
  amountTotal: number;
  currency: "eur";
  label: string;
};

/**
 * SHIPPING V1 is for France metropolitan and Corsica only. DOM/COM are excluded.
 * ISO country FR alone cannot distinguish metropolitan France/Corsica from DOM/COM,
 * so a separate postal-address control is mandatory before Stripe Checkout is enabled.
 */
export function quoteShipping(productsSubtotal: unknown, locale: unknown): ShippingQuote {
  if (
    typeof productsSubtotal !== "number" ||
    !Number.isFinite(productsSubtotal) ||
    !Number.isInteger(productsSubtotal) ||
    productsSubtotal < 0
  ) {
    throw new TypeError("INVALID_PRODUCTS_SUBTOTAL");
  }

  if (!isLocale(locale)) {
    throw new TypeError("INVALID_SHIPPING_LOCALE");
  }

  const shippingAmount = productsSubtotal < FREE_SHIPPING_THRESHOLD ? FR_SHIPPING_AMOUNT : 0;

  return {
    shippingCountry: "FR",
    shippingZone: "FR",
    shippingAmount,
    amountTotal: productsSubtotal + shippingAmount,
    currency: "eur",
    label: shippingLabel(locale),
  };
}

function shippingLabel(locale: Locale) {
  return locale === "fr" ? "Livraison sécurisée" : "Secure shipping";
}
