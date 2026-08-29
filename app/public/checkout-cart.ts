import type { TranslationDictionary } from "../i18n";
import type { Locale } from "../i18n/config";
import { getPublicProduct, ringSizes } from "./home-catalog";
import type { HistoricalCartItem } from "./historical-cart";

export const MAX_CART_QUANTITY = 5;

export type CheckoutSessionItem = {
  productId: string;
  size: number;
  quantity: number;
};

export type CheckoutDisplayLine = {
  item: HistoricalCartItem;
  name: string;
  price: number;
  quantity: number;
  lineTotal: number;
};

function displayQuantity(value: number): number {
  return Number.isInteger(value) && value > 0 ? value : 0;
}

function fallbackPrice(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export function checkoutDisplayLine(item: HistoricalCartItem, dictionary: TranslationDictionary): CheckoutDisplayLine {
  const product = getPublicProduct(item.productId);
  const quantity = displayQuantity(item.quantity);
  const fallbackName = typeof item.name === "string" && item.name.trim() ? item.name.trim() : dictionary.checkout.unavailableItem;
  const price = product?.price ?? fallbackPrice(item.price);

  return {
    item,
    name: product ? dictionary.home.products[product.id].name : fallbackName,
    price,
    quantity,
    lineTotal: price * quantity,
  };
}

export function checkoutTotal(cart: HistoricalCartItem[], dictionary: TranslationDictionary): number {
  return cart.reduce((total, item) => total + checkoutDisplayLine(item, dictionary).lineTotal, 0);
}

export function changeCheckoutQuantity(
  cart: HistoricalCartItem[],
  key: string,
  direction: -1 | 1,
): HistoricalCartItem[] {
  return cart
    .map((item) => item.key !== key ? item : {
      ...item,
      quantity: direction === 1 ? Math.min(MAX_CART_QUANTITY, item.quantity + 1) : item.quantity - 1,
    })
    .filter((item) => item.quantity > 0);
}

export function removeCheckoutItem(cart: HistoricalCartItem[], key: string): HistoricalCartItem[] {
  return cart.filter((item) => item.key !== key);
}

export function checkoutSessionItems(cart: HistoricalCartItem[]): CheckoutSessionItem[] {
  return cart.map(({ productId, size, quantity }) => ({ productId, size, quantity }));
}

export function localizedCheckoutSessionPayload(cart: HistoricalCartItem[], locale: Locale) {
  return { items: checkoutSessionItems(cart), locale } as const;
}

export function isCheckoutItemValid(item: HistoricalCartItem): boolean {
  return Boolean(
    getPublicProduct(item.productId)
    && ringSizes.some(([size]) => size === item.size)
    && Number.isInteger(item.quantity)
    && item.quantity >= 1
    && item.quantity <= MAX_CART_QUANTITY,
  );
}

export function interpolateCheckoutText(template: string, product: string): string {
  return template.replace("{product}", product);
}
