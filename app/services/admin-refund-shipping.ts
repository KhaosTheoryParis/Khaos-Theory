export type AdminRefundShippingState = {
  shippingAmount: number | null;
  shippingRefundedAmount: number | null;
  reservedShippingRefundAmount: number | null;
};

export type AdminRefundShippingSummary = {
  label: "Livraison sécurisée / Secure shipping";
  amount: number;
  refundedAmount: number;
  reservedAmount: number;
  refundableAmount: number;
};

export class AdminRefundShippingError extends Error {
  readonly code: "INVALID_SHIPPING_REFUND_STATE" | "SHIPPING_REFUND_AMOUNT_UNAVAILABLE";

  constructor(code: AdminRefundShippingError["code"]) {
    super(code);
    this.name = "AdminRefundShippingError";
    this.code = code;
  }
}

export function adminRefundShippingSummary(
  state: AdminRefundShippingState,
): AdminRefundShippingSummary | null {
  const refundedAmount = state.shippingRefundedAmount ?? 0;
  const reservedAmount = state.reservedShippingRefundAmount ?? 0;
  if (
    (state.shippingAmount !== null &&
      (!Number.isSafeInteger(state.shippingAmount) || state.shippingAmount < 0)) ||
    !Number.isSafeInteger(refundedAmount) || refundedAmount < 0 ||
    !Number.isSafeInteger(reservedAmount) || reservedAmount < 0 ||
    (state.shippingAmount === null && (refundedAmount !== 0 || reservedAmount !== 0)) ||
    (state.shippingAmount !== null && refundedAmount + reservedAmount > state.shippingAmount)
  ) {
    throw new AdminRefundShippingError("INVALID_SHIPPING_REFUND_STATE");
  }
  if (state.shippingAmount === null || state.shippingAmount === 0) return null;

  return {
    label: "Livraison sécurisée / Secure shipping",
    amount: state.shippingAmount,
    refundedAmount,
    reservedAmount,
    refundableAmount: state.shippingAmount - refundedAmount - reservedAmount,
  };
}

export function resolveAdminShippingRefundAmount(
  state: AdminRefundShippingState,
  refundShipping: boolean,
) {
  const summary = adminRefundShippingSummary(state);
  if (!refundShipping) return 0;
  if (!summary || summary.refundableAmount <= 0) {
    throw new AdminRefundShippingError("SHIPPING_REFUND_AMOUNT_UNAVAILABLE");
  }
  return summary.refundableAmount;
}
