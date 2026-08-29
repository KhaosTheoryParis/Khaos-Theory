export type CheckoutRequestBody = {
  items?: Array<{
    productId?: unknown;
    size?: unknown;
    quantity?: unknown;
  }>;
};

export function isCheckoutRequestBody(value: unknown): value is CheckoutRequestBody {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
