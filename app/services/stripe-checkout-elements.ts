import Stripe from "stripe";
import { isLocale, type Locale } from "../i18n/config";
import {
  CURRENT_TERMS_VERSION,
  isCanonicalUtcTimestamp,
  readCheckoutTermsAcceptance,
} from "./checkout-terms";
import { validateFrShippingDestination } from "./fr-shipping-destination";
import {
  CHECKOUT_CURRENCY,
  prepareCheckoutCart,
  rebuildCheckoutCartFromStripeLineItems,
  type PreparedCheckoutCart,
} from "./checkout-catalog";
import { resolveCheckoutShipping } from "./stripe-checkout-shipping";
import { quoteShipping } from "./shipping";

export const CHECKOUT_ELEMENTS_FLOW = "khaos_fr_shipping_elements_v1";
export const CHECKOUT_STRIPE_TIMEOUT_MS = 10_000;
export const CHECKOUT_STRIPE_MAX_NETWORK_RETRIES = 0;
const CHECKOUT_CLIENT_SECRET_MAX_LENGTH = 512;
const CHECKOUT_CLIENT_SECRET_MIN_SUFFIX_LENGTH = 16;

export type CheckoutSessionUpdateParams = NonNullable<Parameters<Stripe["checkout"]["sessions"]["update"]>[1]>;
type CheckoutShippingDetailsParam = NonNullable<
  NonNullable<CheckoutSessionUpdateParams["collected_information"]>["shipping_details"]
>;

export type CreateCheckoutSessionPort = {
  create(params: Stripe.Checkout.SessionCreateParams): Promise<Stripe.Checkout.Session>;
};

export type UpdateCheckoutSessionPort = {
  retrieve(id: string): Promise<Stripe.Checkout.Session>;
  listLineItems(id: string): Promise<Stripe.ApiList<Stripe.LineItem>>;
  update(
    id: string,
    params: CheckoutSessionUpdateParams,
    options: Stripe.RequestOptions,
  ): Promise<Stripe.Checkout.Session>;
};

export type CheckoutShippingDetails = {
  firstName: string;
  lastName: string;
  address: {
    country: string;
    postal_code: string;
    city: string;
    line1: string;
    line2?: string;
  };
};

export type CheckoutShippingUpdateBody = {
  checkoutSessionId: string;
  clientSecret: string;
  shippingDetails: CheckoutShippingDetails;
};

export type CheckoutTermsAcceptanceBody = {
  checkoutSessionId: string;
  clientSecret: string;
};

export class CheckoutElementsError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = "CheckoutElementsError";
    this.status = status;
    this.code = code;
  }
}

export function createCheckoutStripeClient(secretKey: string) {
  return new Stripe(secretKey, {
    timeout: CHECKOUT_STRIPE_TIMEOUT_MS,
    maxNetworkRetries: CHECKOUT_STRIPE_MAX_NETWORK_RETRIES,
    httpClient: Stripe.createFetchHttpClient(),
  });
}

export function checkoutElementsReturnUrl(siteUrl: string, locale: Locale) {
  return `${siteUrl}/${locale}/success?session_id={CHECKOUT_SESSION_ID}`;
}

export function checkoutElementsSessionParams(
  cart: PreparedCheckoutCart,
  locale: Locale,
  siteUrl: string,
): Stripe.Checkout.SessionCreateParams {
  return {
    mode: "payment",
    ui_mode: "elements",
    locale,
    billing_address_collection: "required",
    permissions: {
      update_shipping_details: "server_only",
    },
    shipping_address_collection: {
      allowed_countries: ["FR"],
    },
    metadata: {
      schema_version: "1",
      checkout_flow: CHECKOUT_ELEMENTS_FLOW,
      checkout_locale: locale,
      terms_required: CURRENT_TERMS_VERSION,
    },
    line_items: cart.lineItems,
    return_url: checkoutElementsReturnUrl(siteUrl, locale),
  };
}

export function parseCheckoutTermsAcceptanceBody(value: unknown): CheckoutTermsAcceptanceBody | null {
  if (!isRecord(value) || !hasExactKeys(value, ["checkoutSessionId", "clientSecret"])) {
    return null;
  }

  const { checkoutSessionId, clientSecret } = value;
  if (
    typeof checkoutSessionId !== "string" ||
    !/^cs_test_[A-Za-z0-9_]+$/u.test(checkoutSessionId) ||
    checkoutSessionId.length > 255
  ) {
    return null;
  }

  const clientSecretPrefix = `${checkoutSessionId}_secret_`;
  if (
    typeof clientSecret !== "string" ||
    !clientSecret.startsWith(clientSecretPrefix) ||
    clientSecret.length < clientSecretPrefix.length + CHECKOUT_CLIENT_SECRET_MIN_SUFFIX_LENGTH ||
    clientSecret.length > CHECKOUT_CLIENT_SECRET_MAX_LENGTH
  ) {
    return null;
  }

  return { checkoutSessionId, clientSecret };
}

export async function acceptCheckoutTerms({
  body,
  stripe,
  now = () => new Date(),
}: {
  body: CheckoutTermsAcceptanceBody;
  stripe: UpdateCheckoutSessionPort;
  now?: () => Date;
}) {
  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.retrieve(body.checkoutSessionId);
  } catch {
    throw new CheckoutElementsError(400, "INVALID_CHECKOUT_SESSION");
  }

  await assertOwnedShippingSession(session, body);
  if (session.metadata?.terms_required !== CURRENT_TERMS_VERSION) {
    throw new CheckoutElementsError(400, "INVALID_CHECKOUT_SESSION");
  }

  let lineItems: Stripe.ApiList<Stripe.LineItem>;
  try {
    lineItems = await stripe.listLineItems(session.id);
  } catch {
    throw new CheckoutElementsError(502, "CHECKOUT_LINE_ITEMS_UNAVAILABLE");
  }
  if (lineItems.has_more) throw new CheckoutElementsError(400, "INVALID_CHECKOUT_LINE_ITEMS");

  const cart = rebuildCheckoutCartFromStripeLineItems(lineItems.data);
  if (!cart) throw new CheckoutElementsError(400, "INVALID_CHECKOUT_LINE_ITEMS");
  try {
    if (!resolveCheckoutShipping(session, cart.productsSubtotal)) {
      throw new Error("MISSING_CHECKOUT_SHIPPING");
    }
  } catch {
    throw new CheckoutElementsError(400, "INVALID_CHECKOUT_SESSION");
  }

  if (
    session.metadata.terms_version === CURRENT_TERMS_VERSION &&
    isCanonicalUtcTimestamp(session.metadata.terms_accepted_at)
  ) {
    return readCheckoutTermsAcceptance(session);
  }

  const termsAcceptedAt = now().toISOString();
  let updated: Stripe.Checkout.Session;
  try {
    updated = await stripe.update(
      session.id,
      {
        metadata: {
          terms_version: CURRENT_TERMS_VERSION,
          terms_accepted_at: termsAcceptedAt,
        },
      },
      { idempotencyKey: `terms-v1:${session.id}:${CURRENT_TERMS_VERSION}` },
    );
  } catch {
    throw new CheckoutElementsError(502, "CHECKOUT_TERMS_UPDATE_FAILED");
  }

  try {
    await assertOwnedShippingSession(updated, body);
    if (!resolveCheckoutShipping(updated, cart.productsSubtotal)) {
      throw new Error("MISSING_CHECKOUT_SHIPPING");
    }
    return readCheckoutTermsAcceptance(updated);
  } catch {
    throw new CheckoutElementsError(502, "INVALID_UPDATED_CHECKOUT_SESSION");
  }
}

export function parseCheckoutShippingUpdateBody(value: unknown): CheckoutShippingUpdateBody | null {
  if (!isRecord(value) || !hasExactKeys(value, ["checkoutSessionId", "clientSecret", "shippingDetails"])) {
    return null;
  }

  const { checkoutSessionId, clientSecret, shippingDetails } = value;
  if (
    typeof checkoutSessionId !== "string" ||
    !/^cs_test_[A-Za-z0-9_]+$/u.test(checkoutSessionId) ||
    checkoutSessionId.length > 255
  ) {
    return null;
  }

  const clientSecretPrefix = `${checkoutSessionId}_secret_`;
  if (
    typeof clientSecret !== "string" ||
    !clientSecret.startsWith(clientSecretPrefix) ||
    clientSecret.length < clientSecretPrefix.length + CHECKOUT_CLIENT_SECRET_MIN_SUFFIX_LENGTH ||
    clientSecret.length > CHECKOUT_CLIENT_SECRET_MAX_LENGTH ||
    !isRecord(shippingDetails) ||
    !hasExactKeys(shippingDetails, ["address", "firstName", "lastName"])
  ) {
    return null;
  }

  const { firstName, lastName, address } = shippingDetails;
  const normalizedFirstName = typeof firstName === "string" ? firstName.trim() : "";
  const normalizedLastName = typeof lastName === "string" ? lastName.trim() : "";
  if (
    !normalizedFirstName ||
    !normalizedLastName ||
    normalizedFirstName.length > 100 ||
    normalizedLastName.length > 100 ||
    `${normalizedFirstName} ${normalizedLastName}`.length > 200 ||
    !isRecord(address) ||
    !hasOnlyKeys(address, ["city", "country", "line1", "line2", "postal_code"], ["city", "country", "line1", "postal_code"]) ||
    typeof address.country !== "string" ||
    typeof address.postal_code !== "string" ||
    typeof address.city !== "string" ||
    typeof address.line1 !== "string" ||
    address.line1.trim().length === 0 ||
    address.line1.length > 200 ||
    (address.line2 !== undefined && (typeof address.line2 !== "string" || address.line2.length > 200))
  ) {
    return null;
  }

  return {
    checkoutSessionId,
    clientSecret,
    shippingDetails: {
      firstName: normalizedFirstName,
      lastName: normalizedLastName,
      address: {
        country: address.country,
        postal_code: address.postal_code,
        city: address.city,
        line1: address.line1.trim(),
        ...(typeof address.line2 === "string" && address.line2.trim()
          ? { line2: address.line2.trim() }
          : {}),
      },
    },
  };
}

export async function updateCheckoutShipping({
  body,
  stripe,
}: {
  body: CheckoutShippingUpdateBody;
  stripe: UpdateCheckoutSessionPort;
}) {
  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.retrieve(body.checkoutSessionId);
  } catch {
    throw new CheckoutElementsError(400, "INVALID_CHECKOUT_SESSION");
  }

  await assertOwnedShippingSession(session, body);

  let lineItems: Stripe.ApiList<Stripe.LineItem>;
  try {
    lineItems = await stripe.listLineItems(session.id);
  } catch {
    throw new CheckoutElementsError(502, "CHECKOUT_LINE_ITEMS_UNAVAILABLE");
  }
  if (lineItems.has_more) throw new CheckoutElementsError(400, "INVALID_CHECKOUT_LINE_ITEMS");

  const cart = rebuildCheckoutCartFromStripeLineItems(lineItems.data);
  if (
    !cart ||
    session.amount_subtotal !== cart.productsSubtotal ||
    session.total_details?.amount_discount !== 0 ||
    session.total_details.amount_tax !== 0
  ) {
    throw new CheckoutElementsError(400, "INVALID_CHECKOUT_LINE_ITEMS");
  }

  const destination = validateFrShippingDestination({
    country: body.shippingDetails.address.country,
    postalCode: body.shippingDetails.address.postal_code,
    city: body.shippingDetails.address.city,
  });
  if (!destination.eligible) throw new CheckoutElementsError(422, "SHIPPING_DESTINATION_INELIGIBLE");

  const locale = session.metadata?.checkout_locale;
  if (!isLocale(locale)) throw new CheckoutElementsError(400, "INVALID_CHECKOUT_SESSION");
  const quote = quoteShipping(cart.productsSubtotal, locale);
  const shippingName = `${body.shippingDetails.firstName} ${body.shippingDetails.lastName}`;
  const shippingDetails: CheckoutShippingDetailsParam = {
    name: shippingName,
    address: {
      country: "FR",
      postal_code: destination.postalCode,
      city: body.shippingDetails.address.city.trim(),
      line1: body.shippingDetails.address.line1,
      ...(body.shippingDetails.address.line2 ? { line2: body.shippingDetails.address.line2 } : {}),
    },
  };
  const params: CheckoutSessionUpdateParams = {
    collected_information: { shipping_details: shippingDetails },
    shipping_options: [{
      shipping_rate_data: {
        display_name: quote.label,
        type: "fixed_amount",
        fixed_amount: { amount: quote.shippingAmount, currency: quote.currency },
      },
    }],
  };
  const addressDigest = await sha256Hex(JSON.stringify({
    address: shippingDetails.address,
    firstName: body.shippingDetails.firstName,
    lastName: body.shippingDetails.lastName,
    shippingAmount: quote.shippingAmount,
    policy: CHECKOUT_ELEMENTS_FLOW,
  }));

  let updated: Stripe.Checkout.Session;
  try {
    updated = await stripe.update(session.id, params, {
      idempotencyKey: `shipping-v1:${session.id}:${addressDigest.slice(0, 40)}`,
    });
  } catch {
    throw new CheckoutElementsError(502, "CHECKOUT_SHIPPING_UPDATE_FAILED");
  }

  assertUpdatedShippingSession(
    updated,
    cart.productsSubtotal,
    quote.shippingAmount,
    destination.postalCode,
    destination.city,
    shippingName,
  );
  return {
    checkoutSessionId: updated.id,
    productsSubtotal: cart.productsSubtotal,
    shippingAmount: quote.shippingAmount,
    amountTotal: quote.amountTotal,
    currency: quote.currency,
  } as const;
}

async function assertOwnedShippingSession(
  session: Stripe.Checkout.Session,
  body: Pick<CheckoutShippingUpdateBody, "checkoutSessionId" | "clientSecret">,
) {
  const allowedCountries = session.shipping_address_collection?.allowed_countries;
  if (
    session.id !== body.checkoutSessionId ||
    !session.id.startsWith("cs_test_") ||
    session.livemode !== false ||
    session.ui_mode !== "elements" ||
    session.mode !== "payment" ||
    session.status !== "open" ||
    session.payment_status !== "unpaid" ||
    session.currency !== CHECKOUT_CURRENCY ||
    session.permissions?.update_shipping_details !== "server_only" ||
    !Array.isArray(allowedCountries) ||
    allowedCountries.length !== 1 ||
    allowedCountries[0] !== "FR" ||
    session.metadata?.schema_version !== "1" ||
    session.metadata.checkout_flow !== CHECKOUT_ELEMENTS_FLOW ||
    !isLocale(session.metadata.checkout_locale) ||
    typeof session.client_secret !== "string" ||
    !(await equalCapabilities(session.client_secret, body.clientSecret))
  ) {
    throw new CheckoutElementsError(400, "INVALID_CHECKOUT_SESSION");
  }
}

function assertUpdatedShippingSession(
  session: Stripe.Checkout.Session,
  productsSubtotal: number,
  shippingAmount: number,
  postalCode: string,
  normalizedCity: string,
  shippingName: string,
) {
  const returnedShippingDetails = session.collected_information?.shipping_details;
  const address = returnedShippingDetails?.address;
  const returnedDestination = validateFrShippingDestination({
    country: address?.country,
    postalCode: address?.postal_code,
    city: address?.city,
  });
  if (
    session.amount_subtotal !== productsSubtotal ||
    session.shipping_cost?.amount_subtotal !== shippingAmount ||
    session.shipping_cost.amount_tax !== 0 ||
    session.shipping_cost.amount_total !== shippingAmount ||
    session.total_details?.amount_shipping !== shippingAmount ||
    session.total_details.amount_discount !== 0 ||
    session.total_details.amount_tax !== 0 ||
    session.amount_total !== productsSubtotal + shippingAmount ||
    returnedShippingDetails?.name !== shippingName ||
    !returnedDestination.eligible ||
    returnedDestination.postalCode !== postalCode ||
    returnedDestination.city !== normalizedCity
  ) {
    throw new CheckoutElementsError(502, "INVALID_UPDATED_CHECKOUT_SESSION");
  }
}

async function equalCapabilities(left: string, right: string) {
  const [leftHash, rightHash] = await Promise.all([sha256Bytes(left), sha256Bytes(right)]);
  let difference = 0;
  for (let index = 0; index < leftHash.length; index += 1) {
    difference |= leftHash[index] ^ rightHash[index];
  }
  return difference === 0;
}

async function sha256Hex(value: string) {
  const digest = await sha256Bytes(value);
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Bytes(value: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return keys.length === sortedExpected.length && keys.every((key, index) => key === sortedExpected[index]);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[]) {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key)) && keys.every((key) => allowed.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function prepareCheckoutElementsCart(value: unknown, randomUUID?: () => string) {
  return prepareCheckoutCart(value, randomUUID);
}
