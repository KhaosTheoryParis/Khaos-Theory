import type { HomeProductId } from "../i18n/types";

export const HISTORICAL_CART_STORAGE_KEY = "khaosTheoryCart";

export type HistoricalCartItem = {
  key: string;
  productId: string;
  name: string;
  price: number;
  size: number;
  usSize: string;
  quantity: number;
};

function toHistoricalCartItem(value: unknown): HistoricalCartItem | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const size = normalizeHistoricalSize(item.size);
  if (
    typeof item.key !== "string"
    || typeof item.productId !== "string"
    || typeof item.name !== "string"
    || typeof item.price !== "number"
    || !Number.isFinite(item.price)
    || size === null
    || typeof item.usSize !== "string"
    || typeof item.quantity !== "number"
    || !Number.isInteger(item.quantity)
  ) return null;

  return {
    key: item.key,
    productId: item.productId,
    name: item.name,
    price: item.price,
    size,
    usSize: item.usSize,
    quantity: item.quantity,
  };
}

function normalizeHistoricalSize(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 48 && value <= 70) {
    return value;
  }
  if (typeof value === "string" && /^(?:4[8-9]|[5-6][0-9]|70)$/u.test(value)) {
    return Number(value);
  }
  return null;
}

type ProductForHistoricalCart = {
  id: HomeProductId;
  name: string;
  price: number;
};

export function addToHistoricalCart(
  cart: HistoricalCartItem[],
  product: ProductForHistoricalCart,
  size: number,
  usSize: string,
  quantity: number,
): HistoricalCartItem[] {
  const key = `${product.id}-${size}`;
  const nextCart = cart.map((item) => ({ ...item }));
  const existingItem = nextCart.find((item) => item.key === key);

  if (existingItem) {
    existingItem.productId = product.id;
    existingItem.quantity += quantity;
  } else {
    nextCart.push({ key, productId: product.id, name: product.name, price: product.price, size, usSize, quantity });
  }

  return nextCart;
}

export function readHistoricalCart(storage: Storage): HistoricalCartItem[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(HISTORICAL_CART_STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.map(toHistoricalCartItem).filter((item): item is HistoricalCartItem => item !== null)
      : [];
  } catch {
    return [];
  }
}

export function writeHistoricalCart(storage: Storage, cart: HistoricalCartItem[]): void {
  storage.setItem(HISTORICAL_CART_STORAGE_KEY, JSON.stringify(cart));
}
