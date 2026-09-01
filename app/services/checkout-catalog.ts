import type Stripe from "stripe";

export const CHECKOUT_CURRENCY = "eur";
export const CHECKOUT_MAX_QUANTITY = 5;
export const CHECKOUT_MIN_SIZE = 48;
export const CHECKOUT_MAX_SIZE = 70;

export const CHECKOUT_CATALOG = {
  geometry: { name: "Geometry", amount: 25_000 },
  "carved-cross": { name: "Karved Kross", amount: 20_000 },
  "hollow-cross": { name: "Hollow Kross", amount: 20_000 },
  "signet-corner": { name: "Signet Korner", amount: 20_000 },
  "damaged-ring-i": { name: "Damaged Ring I", amount: 15_000 },
  "damaged-ring-ii": { name: "Damaged Ring II", amount: 15_000 },
} as const;

export type CheckoutCatalogId = keyof typeof CHECKOUT_CATALOG;

export type ValidatedCheckoutItem = {
  productId: CheckoutCatalogId;
  size: number;
  quantity: number;
};

export type PreparedCheckoutCart = {
  items: ValidatedCheckoutItem[];
  lineItems: Stripe.Checkout.SessionCreateParams.LineItem[];
  productsSubtotal: number;
};

const ITEM_KEYS = ["productId", "quantity", "size"] as const;

export function prepareCheckoutCart(
  value: unknown,
  randomUUID: () => string = () => crypto.randomUUID(),
): PreparedCheckoutCart | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) return null;

  const items: ValidatedCheckoutItem[] = [];
  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [];
  let productsSubtotal = 0;

  for (const valueItem of value) {
    const item = parseCheckoutItem(valueItem);
    if (!item) return null;

    const product = CHECKOUT_CATALOG[item.productId];
    const lineAmount = product.amount * item.quantity;
    if (!Number.isSafeInteger(lineAmount) || !Number.isSafeInteger(productsSubtotal + lineAmount)) {
      return null;
    }

    const lineMetadata = {
      catalog_id: item.productId,
      order_line_id: randomUUID(),
      size_fr: String(item.size),
      pennylane_vat_rate: "exempt",
      schema_version: "1",
    };

    items.push(item);
    lineItems.push({
      price_data: {
        currency: CHECKOUT_CURRENCY,
        product_data: {
          name: `${product.name} — FR ${item.size}`,
          metadata: lineMetadata,
        },
        unit_amount: product.amount,
      },
      quantity: item.quantity,
      metadata: lineMetadata,
    });
    productsSubtotal += lineAmount;
  }

  return { items, lineItems, productsSubtotal };
}

export function rebuildCheckoutCartFromStripeLineItems(
  lineItems: readonly Stripe.LineItem[],
): { items: ValidatedCheckoutItem[]; productsSubtotal: number } | null {
  if (lineItems.length === 0 || lineItems.length > 100) return null;

  const items: ValidatedCheckoutItem[] = [];
  let productsSubtotal = 0;

  for (const lineItem of lineItems) {
    const metadata = lineItem.metadata;
    const productId = metadata?.catalog_id;
    const sizeText = metadata?.size_fr;
    const quantity = lineItem.quantity;

    if (
      !isCheckoutCatalogId(productId) ||
      typeof sizeText !== "string" ||
      !/^(?:4[8-9]|[5-6][0-9]|70)$/u.test(sizeText) ||
      !Number.isInteger(quantity) ||
      (quantity as number) < 1 ||
      (quantity as number) > CHECKOUT_MAX_QUANTITY ||
      metadata?.schema_version !== "1" ||
      metadata.pennylane_vat_rate !== "exempt" ||
      typeof metadata.order_line_id !== "string" ||
      metadata.order_line_id.length === 0
    ) {
      return null;
    }

    const product = CHECKOUT_CATALOG[productId];
    const size = Number(sizeText);
    const expectedAmount = product.amount * (quantity as number);
    if (
      lineItem.currency !== CHECKOUT_CURRENCY ||
      lineItem.price?.currency !== CHECKOUT_CURRENCY ||
      lineItem.price.unit_amount !== product.amount ||
      lineItem.amount_subtotal !== expectedAmount ||
      lineItem.amount_total !== expectedAmount ||
      lineItem.amount_discount !== 0 ||
      lineItem.amount_tax !== 0 ||
      !Number.isSafeInteger(productsSubtotal + expectedAmount)
    ) {
      return null;
    }

    items.push({ productId, size, quantity: quantity as number });
    productsSubtotal += expectedAmount;
  }

  return { items, productsSubtotal };
}

function parseCheckoutItem(value: unknown): ValidatedCheckoutItem | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.length !== ITEM_KEYS.length || keys.some((key, index) => key !== ITEM_KEYS[index])) {
    return null;
  }

  const { productId, quantity, size } = value;
  if (
    !isCheckoutCatalogId(productId) ||
    typeof quantity !== "number" ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > CHECKOUT_MAX_QUANTITY ||
    typeof size !== "number" ||
    !Number.isInteger(size) ||
    size < CHECKOUT_MIN_SIZE ||
    size > CHECKOUT_MAX_SIZE
  ) {
    return null;
  }

  return { productId, size, quantity };
}

function isCheckoutCatalogId(value: unknown): value is CheckoutCatalogId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CHECKOUT_CATALOG, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
