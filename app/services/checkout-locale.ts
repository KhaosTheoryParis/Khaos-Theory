import { defaultLocale, isLocale, type Locale } from "../i18n/config";

export type CheckoutLocaleResult =
  | { ok: true; locale: Locale }
  | { ok: false };

export function resolveCheckoutLocale(body: object): CheckoutLocaleResult {
  if (!Object.prototype.hasOwnProperty.call(body, "locale")) {
    return { ok: true, locale: defaultLocale };
  }

  const locale = (body as { locale?: unknown }).locale;
  return isLocale(locale) ? { ok: true, locale } : { ok: false };
}

export function checkoutRedirectUrls(siteUrl: string, locale: Locale) {
  return {
    successUrl: `${siteUrl}/${locale}/success?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${siteUrl}/${locale}/checkout`,
  } as const;
}
