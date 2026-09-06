import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CheckoutElementsDebugPanel,
  checkoutConfirmFailureDiagnostic,
  checkoutElementsDebugState,
  isCheckoutElementsDebugEnabled,
} from "../app/public/checkout-elements-payment";
import {
  beginCheckoutConfirmation,
  createCheckoutElementsGate,
  finishCheckoutAddressValidation,
  invalidateCheckoutAddress,
} from "../app/public/checkout-elements-gate";

test("ktdebug must be explicitly enabled by the query parameter", () => {
  assert.equal(isCheckoutElementsDebugEnabled("?ktdebug=1"), true);
  assert.equal(isCheckoutElementsDebugEnabled("?ktdebug=0"), false);
  assert.equal(isCheckoutElementsDebugEnabled("?other=1"), false);
  assert.equal(isCheckoutElementsDebugEnabled(""), false);
});

test("the debug panel exposes only the booleans and gate status from the real confirmation formula", () => {
  const cartKey = "debug-cart";
  let gate = invalidateCheckoutAddress(createCheckoutElementsGate(cartKey), true);
  gate = finishCheckoutAddressValidation(gate, gate.addressRevision, "eligible");
  const state = checkoutElementsDebugState(gate, cartKey, true);

  assert.deepEqual(state, {
    cartKeyCurrent: true,
    gateStatus: "eligible",
    gateEligible: true,
    revisionCurrent: true,
    stripeCanConfirm: true,
    isConfirming: false,
    confirmEnabled: true,
    confirmStep: "idle",
    confirmErrorType: "none",
    confirmResultType: "none",
    confirmStripeErrorType: "none",
    confirmStripeErrorCode: "none",
    confirmStripeDeclineCode: "none",
  });

  const visible = renderToStaticMarkup(createElement(CheckoutElementsDebugPanel, { enabled: true, state }));
  const hidden = renderToStaticMarkup(createElement(CheckoutElementsDebugPanel, { enabled: false, state }));
  assert.match(visible, /data-ktdebug="checkout-confirmation"/);
  for (const line of [
    "cartKeyCurrent: true",
    "gateStatus: eligible",
    "gateEligible: true",
    "revisionCurrent: true",
    "stripeCanConfirm: true",
    "isConfirming: false",
    "confirmEnabled: true",
    "confirmStep: idle",
    "confirmErrorType: none",
    "confirmResultType: none",
    "confirmStripeErrorType: none",
    "confirmStripeErrorCode: none",
    "confirmStripeDeclineCode: none",
  ]) {
    assert.match(visible, new RegExp(line));
  }
  assert.equal(hidden, "");
});

test("debug derivation leaves shipping invalidation and the confirmation lock unchanged", () => {
  const cartKey = "debug-cart";
  let gate = invalidateCheckoutAddress(createCheckoutElementsGate(cartKey), true);
  gate = finishCheckoutAddressValidation(gate, gate.addressRevision, "eligible");
  assert.equal(checkoutElementsDebugState(gate, cartKey, true).confirmEnabled, true);

  const confirming = beginCheckoutConfirmation(gate, cartKey, true);
  assert.ok(confirming);
  assert.deepEqual(checkoutElementsDebugState(confirming, cartKey, true), {
    cartKeyCurrent: true,
    gateStatus: "confirming",
    gateEligible: false,
    revisionCurrent: true,
    stripeCanConfirm: true,
    isConfirming: true,
    confirmEnabled: false,
    confirmStep: "idle",
    confirmErrorType: "none",
    confirmResultType: "none",
    confirmStripeErrorType: "none",
    confirmStripeErrorCode: "none",
    confirmStripeDeclineCode: "none",
  });
  assert.equal(beginCheckoutConfirmation(confirming, cartKey, true), null);

  const changedAddress = invalidateCheckoutAddress(gate, false);
  assert.equal(checkoutElementsDebugState(changedAddress, cartKey, true).confirmEnabled, false);
});

test("the post-click diagnostic marks both Stripe awaits without changing the confirmation gate", () => {
  const cartKey = "debug-cart";
  let gate = invalidateCheckoutAddress(createCheckoutElementsGate(cartKey), true);
  gate = finishCheckoutAddressValidation(gate, gate.addressRevision, "eligible");
  const confirming = beginCheckoutConfirmation(gate, cartKey, true);
  assert.ok(confirming);

  const state = checkoutElementsDebugState(confirming, cartKey, true, "before-confirm", "none");
  assert.equal(state.confirmEnabled, false);
  assert.equal(state.isConfirming, true);
  assert.equal(state.confirmStep, "before-confirm");
  assert.equal(state.confirmErrorType, "none");
  assert.equal(state.confirmResultType, "none");

  const visible = renderToStaticMarkup(createElement(CheckoutElementsDebugPanel, { enabled: true, state }));
  assert.match(visible, /confirmStep: before-confirm/);
  assert.match(visible, /confirmErrorType: none/);
  assert.match(visible, /confirmResultType: none/);

  const source = readFileSync("app/public/checkout-elements-payment.tsx", "utf8");
  const beforeValidate = source.indexOf('setConfirmStep("before-validate")');
  const validate = source.indexOf("await actions.validateElements()", beforeValidate);
  const afterValidate = source.indexOf('setConfirmStep("after-validate")', validate);
  const beforeConfirm = source.indexOf('setConfirmStep("before-confirm")', afterValidate);
  const confirm = source.indexOf('await actions.confirm({ redirect: "always" })', beforeConfirm);
  const afterConfirm = source.indexOf('setConfirmStep("after-confirm")', confirm);
  const catchStep = source.indexOf('setConfirmStep("error")', afterConfirm);
  const finallyStep = source.indexOf('setConfirmStep("finally")', catchStep);

  assert.ok(beforeValidate >= 0);
  assert.ok(validate > beforeValidate);
  assert.ok(afterValidate > validate);
  assert.ok(beforeConfirm > afterValidate);
  assert.ok(confirm > beforeConfirm);
  assert.ok(afterConfirm > confirm);
  assert.ok(catchStep > afterConfirm);
  assert.ok(finallyStep > catchStep);
  assert.match(source.slice(afterConfirm, finallyStep), /setConfirmErrorType\(confirmPhase\)/);
});

test("confirm failures expose only bounded Stripe error classifications", () => {
  const returned = checkoutConfirmFailureDiagnostic({
    type: "card_error",
    code: "paymentFailed",
    message: "raw text must not be surfaced",
    paymentFailed: { declineCode: "do_not_honor" },
  }, "error");
  assert.deepEqual(returned, {
    confirmResultType: "error",
    confirmStripeErrorType: "card_error",
    confirmStripeErrorCode: "paymentFailed",
    confirmStripeDeclineCode: "do_not_honor",
  });

  const rejected = checkoutConfirmFailureDiagnostic({
    name: "IntegrationError",
    code: "unsafe value with spaces",
    message: "opaque runtime detail",
  }, "rejected");
  assert.deepEqual(rejected, {
    confirmResultType: "rejected",
    confirmStripeErrorType: "IntegrationError",
    confirmStripeErrorCode: "unknown",
    confirmStripeDeclineCode: "none",
  });
  assert.doesNotMatch(JSON.stringify({ returned, rejected }), /raw text|opaque runtime detail/);
});

test("a rejected Stripe await exits the confirmation lock without retrying automatically", () => {
  const source = readFileSync("app/public/checkout-elements-payment.tsx", "utf8");
  const confirm = source.indexOf('await actions.confirm({ redirect: "always" })');
  const catchStart = source.indexOf("} catch (error) {", confirm);
  const finallyStart = source.indexOf("} finally {", catchStart);
  assert.ok(confirm >= 0 && catchStart > confirm && finallyStart > catchStart);

  const catchSource = source.slice(catchStart, finallyStart);
  assert.match(catchSource, /checkoutConfirmFailureDiagnostic\(error, "rejected"\)/);
  assert.match(catchSource, /status: "error" as const/);
  assert.match(catchSource, /validatedAddressRevision: null/);
  assert.match(catchSource, /dictionary\.checkout\.paymentError/);
  assert.doesNotMatch(catchSource, /actions\.confirm|setTimeout|console\./);
  assert.equal(source.match(/actions\.confirm\(\{ redirect: "always" \}\)/gu)?.length, 1);
});

test("the diagnostic surface contains no customer, session, payment, or secret values", () => {
  const source = readFileSync("app/public/checkout-elements-payment.tsx", "utf8");
  const panelStart = source.indexOf("export function CheckoutElementsDebugPanel");
  const panelEnd = source.indexOf("export default function CheckoutElementsPayment");
  assert.ok(panelStart >= 0 && panelEnd > panelStart);
  const panelSource = source.slice(panelStart, panelEnd);

  assert.doesNotMatch(panelSource, /clientSecret|checkoutSessionId|PaymentIntent|metadata|cookie|header/i);
  assert.doesNotMatch(panelSource, /postal|city|email|phone|card|cvc|address|name/i);
  assert.doesNotMatch(panelSource, /console\.|fetch\(/);
});
