export type CheckoutElementsGateStatus =
  | "initializing"
  | "incomplete"
  | "checking"
  | "eligible"
  | "ineligible"
  | "error"
  | "confirming";

export type CheckoutElementsGate = {
  cartKey: string;
  addressRevision: number;
  validatedAddressRevision: number | null;
  status: CheckoutElementsGateStatus;
};

export function createCheckoutElementsGate(cartKey: string): CheckoutElementsGate {
  return {
    cartKey,
    addressRevision: 0,
    validatedAddressRevision: null,
    status: "initializing",
  };
}

export function invalidateCheckoutAddress(
  gate: CheckoutElementsGate,
  complete: boolean,
): CheckoutElementsGate {
  return {
    ...gate,
    addressRevision: gate.addressRevision + 1,
    validatedAddressRevision: null,
    status: complete ? "checking" : "incomplete",
  };
}

export function finishCheckoutAddressValidation(
  gate: CheckoutElementsGate,
  addressRevision: number,
  outcome: "eligible" | "ineligible" | "error",
): CheckoutElementsGate {
  if (gate.addressRevision !== addressRevision) return gate;
  return {
    ...gate,
    validatedAddressRevision: outcome === "eligible" ? addressRevision : null,
    status: outcome,
  };
}

export function invalidateCheckoutCart(gate: CheckoutElementsGate, cartKey: string) {
  return createCheckoutElementsGate(cartKey === gate.cartKey ? `${cartKey}:invalidated` : cartKey);
}

export function canConfirmCheckoutElements(
  gate: CheckoutElementsGate,
  cartKey: string,
  stripeCanConfirm: boolean,
) {
  return Boolean(
    gate.cartKey === cartKey &&
    gate.status === "eligible" &&
    gate.validatedAddressRevision === gate.addressRevision &&
    stripeCanConfirm,
  );
}

export function beginCheckoutConfirmation(
  gate: CheckoutElementsGate,
  cartKey: string,
  stripeCanConfirm: boolean,
): CheckoutElementsGate | null {
  if (!canConfirmCheckoutElements(gate, cartKey, stripeCanConfirm)) return null;
  return { ...gate, status: "confirming" };
}
