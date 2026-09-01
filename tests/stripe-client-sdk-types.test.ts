import assert from "node:assert/strict";
import test from "node:test";
import type {
  Stripe,
  StripeAddressElementChangeEvent,
  StripeCheckoutElementsSdk,
  StripeCheckoutElementsSdkOptions,
  StripeCheckoutLoadActionsSuccess,
} from "@stripe/stripe-js";

type LoadStripe = typeof import("@stripe/stripe-js/pure/index.js").loadStripe;
type ElementsInitializer = Stripe["initCheckoutElementsSdk"];
type ShippingElementFactory = StripeCheckoutElementsSdk["createShippingAddressElement"];
type PaymentElementFactory = StripeCheckoutElementsSdk["createPaymentElement"];
type ContactElementFactory = StripeCheckoutElementsSdk["createContactDetailsElement"];
type RunServerUpdate = StripeCheckoutLoadActionsSuccess["runServerUpdate"];
type ValidateElements = StripeCheckoutLoadActionsSuccess["validateElements"];
type Confirm = StripeCheckoutLoadActionsSuccess["confirm"];

const elementsOptions: StripeCheckoutElementsSdkOptions = {
  clientSecret: Promise.resolve("cs_test_not_real_secret_not_real"),
};

const shippingChangeHandler = (event: StripeAddressElementChangeEvent) => {
  const complete: boolean = event.complete;
  const name: string = event.value.name;
  const country: string = event.value.address.country;
  const postalCode: string = event.value.address.postal_code;
  const city: string = event.value.address.city;
  void complete;
  void name;
  void country;
  void postalCode;
  void city;
};

type TypeContract = {
  loadStripe: LoadStripe;
  initCheckoutElementsSdk: ElementsInitializer;
  createShippingAddressElement: ShippingElementFactory;
  createPaymentElement: PaymentElementFactory;
  createContactDetailsElement: ContactElementFactory;
  runServerUpdate: RunServerUpdate;
  validateElements: ValidateElements;
  confirm: Confirm;
};

test("Stripe.js 9.14 exposes the typed Checkout Elements shipping lifecycle without runtime calls", () => {
  assert.equal(typeof shippingChangeHandler, "function");
  assert.equal(typeof elementsOptions.clientSecret === "string" || elementsOptions.clientSecret instanceof Promise, true);
  assert.equal(true satisfies (TypeContract extends object ? true : false), true);
});
