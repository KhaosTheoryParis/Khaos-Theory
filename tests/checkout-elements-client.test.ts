import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { StripeCheckoutLoadActionsSuccess, StripeCheckoutSession } from "@stripe/stripe-js";
import {
  beginCheckoutConfirmation,
  canConfirmCheckoutElements,
  createCheckoutElementsGate,
  finishCheckoutAddressValidation,
  invalidateCheckoutAddress,
  invalidateCheckoutCart,
} from "../app/public/checkout-elements-gate";
import CheckoutElementsPayment, {
  canConfirmCheckoutWithTerms,
  createShippingAddressConfirmationLifecycle,
  parseElementsSessionConfig,
  runAuthoritativeShippingUpdate,
  runAuthoritativeTermsAcceptance,
  stripeShippingDetails,
} from "../app/public/checkout-elements-payment";
import { checkoutSessionItems } from "../app/public/checkout-cart";
import { readHistoricalCart, type HistoricalCartItem } from "../app/public/historical-cart";
import { en, fr } from "../app/i18n";

const config = {
  checkoutSessionId: "cs_test_clientElements",
  clientSecret: "cs_test_clientElements_secret_not_real",
  publishableKey: "pk_test_not_real",
};

function checkoutSession(shippingAmount = 1_000, amountTotal = 26_000): StripeCheckoutSession {
  return {
    id: config.checkoutSessionId,
    livemode: false,
    canConfirm: true,
    total: {
      shippingRate: { minorUnitsAmount: shippingAmount, amount: String(shippingAmount) },
      total: { minorUnitsAmount: amountTotal, amount: String(amountTotal) },
    },
  } as StripeCheckoutSession;
}

const shippingDetails = {
  firstName: "Test",
  lastName: "Customer",
  address: {
    country: "FR",
    postal_code: "75001",
    city: "Paris",
    line1: "1 rue de Test",
  },
};

const cart: HistoricalCartItem[] = [{
  key: "geometry-48",
  productId: "geometry",
  name: "Browser display name",
  price: 1,
  size: 48,
  usSize: "4.5",
  quantity: 1,
}];

test("the inactive Elements checkout renders localized FR and EN structure with confirmation closed", () => {
  const frHtml = renderToStaticMarkup(createElement(CheckoutElementsPayment, { cart, locale: "fr", dictionary: fr }));
  const enHtml = renderToStaticMarkup(createElement(CheckoutElementsPayment, { cart, locale: "en", dictionary: en }));

  assert.match(frHtml, /Adresse de livraison/);
  assert.match(frHtml, /Le prix de l’expédition sera calculé après la saisie de votre adresse de livraison\./);
  assert.match(frHtml, /Adresse de facturation/);
  assert.match(frHtml, />E-mail \*</);
  assert.match(frHtml, /Paiement sécurisé/);
  assert.match(frHtml, /J’ai lu et j’accepte les/);
  assert.match(frHtml, /href="\/fr\/terms"/);
  assert.match(frHtml, />Conditions Générales de Vente</);
  assert.match(enHtml, /Shipping address/);
  assert.match(enHtml, /Shipping costs will be calculated after you enter your delivery address\./);
  assert.match(enHtml, /Billing address/);
  assert.match(enHtml, />Email \*</);
  assert.match(enHtml, /Secure payment/);
  assert.match(enHtml, /I have read and accept the/);
  assert.match(enHtml, /href="\/en\/terms"/);
  assert.match(enHtml, />Terms and Conditions</);
  assert.match(frHtml, /type="checkbox"/);
  assert.match(frHtml, /type="checkbox"[^>]*required/);
  assert.doesNotMatch(frHtml, /type="checkbox"[^>]*checked/);
  assert.match(frHtml, /checkout-elements--initializing/);
  assert.match(frHtml, /aria-busy="true"/);
  assert.match(frHtml, /<button[^>]*disabled=""/);
  assert.match(enHtml, /<button[^>]*disabled=""/);
});

test("confirmation remains technically closed until terms are accepted", () => {
  const cartKey = "geometry:48:1";
  let gate = invalidateCheckoutAddress(createCheckoutElementsGate(cartKey), true);
  gate = finishCheckoutAddressValidation(gate, gate.addressRevision, "eligible");

  assert.equal(canConfirmCheckoutWithTerms(gate, cartKey, true, false), false);
  assert.equal(canConfirmCheckoutWithTerms(gate, cartKey, true, true), true);
  assert.equal(canConfirmCheckoutWithTerms(gate, cartKey, false, true), false);
});

test("terms acceptance sends session proof only and no browser-selected version or timestamp", async () => {
  let requestBody: unknown;
  const actions = {
    runServerUpdate: async (callback: () => Promise<unknown>) => {
      await callback();
      return { type: "success" as const, session: checkoutSession() };
    },
  };
  const result = await runAuthoritativeTermsAcceptance(actions, config, async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as unknown;
    return Response.json({ accepted: true });
  });

  assert.equal(result.ok, true);
  assert.deepEqual(requestBody, {
    checkoutSessionId: config.checkoutSessionId,
    clientSecret: config.clientSecret,
  });
  assert.doesNotMatch(JSON.stringify(requestBody), /terms|version|accepted_at|timestamp/i);
});

test("missing or non-test publishable configuration is rejected before Stripe.js initialization", () => {
  assert.equal(parseElementsSessionConfig({
    checkoutSessionId: config.checkoutSessionId,
    clientSecret: config.clientSecret,
  }), null);
  assert.equal(parseElementsSessionConfig({ ...config, publishableKey: "pk_live_forbidden" }), null);
  assert.deepEqual(parseElementsSessionConfig(config), config);
});

test("historical cart display values never enter the authoritative Checkout payload", () => {
  const storage = {
    getItem: () => JSON.stringify([{ ...cart[0], size: "48", price: 0, shippingAmount: 0 }]),
    setItem: () => undefined,
    removeItem: () => undefined,
    clear: () => undefined,
    key: () => null,
    length: 1,
  } satisfies Storage;
  const restored = readHistoricalCart(storage);

  assert.equal(restored[0]?.size, 48);
  assert.deepEqual(checkoutSessionItems(restored), [{ productId: "geometry", size: 48, quantity: 1 }]);
  assert.doesNotMatch(JSON.stringify(checkoutSessionItems(restored)), /price|shipping/i);
});

test("runServerUpdate sends only session proof and address, never browser financial values", async () => {
  let requestBody: unknown;
  const actions = {
    runServerUpdate: async (callback: () => Promise<unknown>) => {
      await callback();
      return { type: "success" as const, session: checkoutSession() };
    },
  };
  const fetcher: typeof fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as unknown;
    return Response.json({ updated: true, shippingAmount: 1_000, amountTotal: 26_000, currency: "eur" });
  };

  const result = await runAuthoritativeShippingUpdate(actions, config, shippingDetails, fetcher);
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(requestBody as object).sort(), ["checkoutSessionId", "clientSecret", "shippingDetails"]);
  assert.deepEqual((requestBody as { shippingDetails: unknown }).shippingDetails, shippingDetails);
  assert.doesNotMatch(JSON.stringify(requestBody), /productsSubtotal|shippingAmount|\btotal\b|shippingZone|\bprice\b/);

  let gate = invalidateCheckoutAddress(createCheckoutElementsGate("cart"), true);
  assert.equal(gate.status, "checking");
  gate = finishCheckoutAddressValidation(gate, gate.addressRevision, "eligible");
  assert.equal(gate.status, "eligible");
  assert.equal(canConfirmCheckoutElements(gate, "cart", true), true);
});

test("split Stripe address names stay separate in the application shipping payload", () => {
  const details = stripeShippingDetails({
    value: {
      name: "Marie Dupont",
      firstName: "Marie",
      lastName: "Dupont",
      address: {
        country: "FR",
        postal_code: "75001",
        city: "Paris",
        line1: "1 rue de Test",
        line2: null,
        state: "",
      },
    },
  });

  assert.deepEqual(details, {
    firstName: "Marie",
    lastName: "Dupont",
    address: {
      country: "FR",
      postal_code: "75001",
      city: "Paris",
      line1: "1 rue de Test",
    },
  });
  assert.equal("name" in details, false);
});

test("server rejection is propagated as an ineligible shipping gate", async () => {
  const actions = {
    runServerUpdate: async (callback: () => Promise<unknown>) => {
      try {
        await callback();
      } catch {
        return { type: "error" as const, error: { message: "rejected", code: null } };
      }
      assert.fail("the 422 callback must reject");
    },
  };
  const fetcher: typeof fetch = async () => Response.json({ updated: false }, { status: 422 });
  assert.deepEqual(
    await runAuthoritativeShippingUpdate(actions, config, shippingDetails, fetcher),
    { ok: false, reason: "ineligible" },
  );
});

test("a server update failure cannot leave confirmation enabled", async () => {
  const actions = {
    runServerUpdate: async (callback: () => Promise<unknown>) => {
      try {
        await callback();
      } catch {
        return { type: "error" as const, error: { message: "failed", code: null } };
      }
      assert.fail("the failed callback must reject");
    },
  };
  const fetcher: typeof fetch = async () => Response.json({ updated: false }, { status: 500 });
  const result = await runAuthoritativeShippingUpdate(actions, config, shippingDetails, fetcher);
  assert.deepEqual(result, { ok: false, reason: "error" });

  let gate = invalidateCheckoutAddress(createCheckoutElementsGate("cart"), true);
  gate = finishCheckoutAddressValidation(gate, gate.addressRevision, result.ok ? "eligible" : result.reason);
  assert.equal(gate.status, "error");
  assert.equal(canConfirmCheckoutElements(gate, "cart", true), false);
});

test("a rejected network update leaves checking and can be retried", async () => {
  const networkFailure = {
    runServerUpdate: async (callback: () => Promise<unknown>) => {
      await callback();
      return { type: "success" as const, session: checkoutSession() };
    },
  };
  const failedResult = await runAuthoritativeShippingUpdate(
    networkFailure,
    config,
    shippingDetails,
    async () => {
      throw new TypeError("Failed to fetch");
    },
  );
  assert.deepEqual(failedResult, { ok: false, reason: "error" });

  let gate = invalidateCheckoutAddress(createCheckoutElementsGate("cart"), true);
  gate = finishCheckoutAddressValidation(gate, gate.addressRevision, failedResult.ok ? "eligible" : failedResult.reason);
  assert.equal(gate.status, "error");
  assert.equal(canConfirmCheckoutElements(gate, "cart", true), false);

  const retryActions = {
    runServerUpdate: async (callback: () => Promise<unknown>) => {
      await callback();
      return { type: "success" as const, session: checkoutSession() };
    },
  };
  const retryResult = await runAuthoritativeShippingUpdate(
    retryActions,
    config,
    shippingDetails,
    async () => Response.json({ updated: true, shippingAmount: 1_000, amountTotal: 26_000, currency: "eur" }),
  );
  gate = invalidateCheckoutAddress(gate, true);
  gate = finishCheckoutAddressValidation(gate, gate.addressRevision, retryResult.ok ? "eligible" : retryResult.reason);
  assert.equal(gate.status, "eligible");
  assert.equal(canConfirmCheckoutElements(gate, "cart", true), true);
});

test("incomplete and changed addresses invalidate confirmation, including stale async results", () => {
  const cartKey = "geometry:48:1";
  let gate = createCheckoutElementsGate(cartKey);
  assert.equal(canConfirmCheckoutElements(gate, cartKey, true), false);

  gate = invalidateCheckoutAddress(gate, true);
  const firstRevision = gate.addressRevision;
  gate = invalidateCheckoutAddress(gate, true);
  const secondRevision = gate.addressRevision;
  gate = finishCheckoutAddressValidation(gate, firstRevision, "eligible");
  assert.equal(gate.addressRevision, secondRevision);
  assert.equal(canConfirmCheckoutElements(gate, cartKey, true), false);

  gate = finishCheckoutAddressValidation(gate, secondRevision, "eligible");
  assert.equal(canConfirmCheckoutElements(gate, cartKey, true), true);
  gate = invalidateCheckoutAddress(gate, false);
  assert.equal(canConfirmCheckoutElements(gate, cartKey, true), false);
});

test("a cart change makes every prior shipping validation unusable", () => {
  let gate = invalidateCheckoutAddress(createCheckoutElementsGate("cart-a"), true);
  gate = finishCheckoutAddressValidation(gate, gate.addressRevision, "eligible");
  assert.equal(canConfirmCheckoutElements(gate, "cart-a", true), true);

  const changed = invalidateCheckoutCart(gate, "cart-b");
  assert.equal(canConfirmCheckoutElements(changed, "cart-a", true), false);
  assert.equal(canConfirmCheckoutElements(changed, "cart-b", true), false);
});

test("starting confirmation closes the gate synchronously against a second click", () => {
  const cartKey = "geometry:48:1";
  let gate = invalidateCheckoutAddress(createCheckoutElementsGate(cartKey), true);
  gate = finishCheckoutAddressValidation(gate, gate.addressRevision, "eligible");

  const started = beginCheckoutConfirmation(gate, cartKey, true);
  assert.equal(started?.status, "confirming");
  assert.equal(beginCheckoutConfirmation(started!, cartKey, true), null);
  assert.equal(canConfirmCheckoutElements(started!, cartKey, true), false);
});

test("the Shipping Address Element is unmounted only for confirm and restored for a human retry", () => {
  const calls: string[] = [];
  const element = {
    unmount: () => calls.push("unmount"),
    mount: () => calls.push("mount"),
  };
  const lifecycle = createShippingAddressConfirmationLifecycle(element, {} as HTMLElement);

  assert.equal(lifecycle.isMounted(), true);
  assert.deepEqual(calls, []);

  lifecycle.unmountBeforeConfirm();
  assert.equal(lifecycle.isMounted(), false);
  assert.deepEqual(calls, ["unmount"]);

  lifecycle.restoreAfterFailure();
  assert.equal(lifecycle.isMounted(), true);
  assert.deepEqual(calls, ["unmount", "mount"]);

  lifecycle.unmountBeforeConfirm();
  lifecycle.restoreAfterFailure();
  assert.equal(lifecycle.isMounted(), true);
  assert.deepEqual(calls, ["unmount", "mount", "unmount", "mount"]);
});

test("a successful confirmation leaves the Shipping Address Element detached for redirect", () => {
  const calls: string[] = [];
  const lifecycle = createShippingAddressConfirmationLifecycle({
    unmount: () => calls.push("unmount"),
    mount: () => calls.push("mount"),
  }, {} as HTMLElement);

  lifecycle.unmountBeforeConfirm();
  lifecycle.markConfirmationSucceeded();
  lifecycle.restoreAfterFailure();

  assert.equal(lifecycle.isMounted(), false);
  assert.deepEqual(calls, ["unmount"]);
});

test("shipping validation finishes before unmount and confirm runs only while the Element is detached", () => {
  const source = readFileSync("app/public/checkout-elements-payment.tsx", "utf8");
  const termsAcceptance = source.indexOf("await runAuthoritativeTermsAcceptance(actions, config)");
  const validate = source.indexOf("await actions.validateElements()", termsAcceptance);
  const unmount = source.indexOf("shippingElementLifecycle.unmountBeforeConfirm()", validate);
  const confirm = source.indexOf('await actions.confirm({ redirect: "always" })', unmount);
  const markSucceeded = source.indexOf("shippingElementLifecycle.markConfirmationSucceeded()", confirm);
  const finallyBlock = source.indexOf("} finally {", markSucceeded);
  const restore = source.indexOf("shippingElementLifecycle.restoreAfterFailure()", finallyBlock);

  assert.ok(termsAcceptance >= 0);
  assert.ok(validate > termsAcceptance);
  assert.ok(unmount > validate);
  assert.ok(confirm > unmount);
  assert.ok(markSucceeded > confirm);
  assert.ok(finallyBlock > markSucceeded);
  assert.ok(restore > finallyBlock);
});

test("required billing and email completion remain part of Stripe canConfirm authority", () => {
  const cartKey = "geometry:48:1";
  let gate = invalidateCheckoutAddress(createCheckoutElementsGate(cartKey), true);
  gate = finishCheckoutAddressValidation(gate, gate.addressRevision, "eligible");
  const stripeCanConfirmWithMissingOrInvalidEmail = false;
  const stripeCanConfirmWithValidEmailAndOtherElementsComplete = true;

  assert.equal(canConfirmCheckoutElements(gate, cartKey, stripeCanConfirmWithMissingOrInvalidEmail), false);
  assert.equal(beginCheckoutConfirmation(gate, cartKey, stripeCanConfirmWithMissingOrInvalidEmail), null);
  assert.equal(canConfirmCheckoutElements(gate, cartKey, stripeCanConfirmWithValidEmailAndOtherElementsComplete), true);
});

test("the current Stripe Session total is read and displayed before confirmation", () => {
  const source = readFileSync("app/public/checkout-elements-payment.tsx", "utf8");
  assert.match(source, /setDisplayTotal\(result\.session\.total\.total\.amount\)/);
  assert.match(source, /setDisplayTotal\(shippingResult\.session\.total\.total\.amount\)/);
  assert.match(source, /<strong>\{displayTotal\}<\/strong>/);
  assert.doesNotMatch(source, /formatCurrency\(displayTotal/);
  assert.match(source, /result\.session\.total\.total\.minorUnitsAmount !== amounts\.amountTotal/);
});

test("the FR and EN Elements UI use the modern typed API and no deprecated callback", () => {
  const source = readFileSync("app/public/checkout-elements-payment.tsx", "utf8");
  assert.match(source, /@stripe\/stripe-js\/pure/);
  assert.match(source, /initCheckoutElementsSdk/);
  assert.match(source, /createShippingAddressElement\(\{ display: \{ name: "split" \} \}\)/);
  assert.match(source, /createBillingAddressElement\(\{ display: \{ name: "split" \} \}\)/);
  assert.match(source, /billingElement\.mount\(billingMountRef\.current\)/);
  assert.match(source, /billingElement\?\.destroy\(\)/);
  assert.match(source, /createContactDetailsElement/);
  assert.match(source, /createPaymentElement/);
  assert.match(source, /sdk\.on\("change"/);
  assert.match(source, /setStripeCanConfirm\(session\.canConfirm\)/);
  assert.match(source, /runServerUpdate/);
  assert.match(source, /runAuthoritativeTermsAcceptance/);
  assert.match(source, /if \(!termsAccepted\)/);
  assert.match(source, /validateElements/);
  assert.match(source, /\.confirm\(\{ redirect: "always" \}\)/);
  assert.match(source, /beginCheckoutConfirmation/);
  assert.match(source, /checkout-elements--\$\{gate\.status\}/);
  assert.match(source, /stripe-checkout-button--processing/);
  assert.match(source, /checkout-status--\$\{gate\.status\}/);
  assert.match(source, /checkoutInitializationError/);
  assert.match(source, /retryInitialization/);
  assert.match(source, /checkout-retry-button/);
  assert.match(source, /initializationFailed \|\| gate\.status === "error"/);
  assert.doesNotMatch(source, /onShippingDetailsChange|EmbeddedCheckout|console\./);
  assert.doesNotMatch(source, /STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|PENNYLANE_API_TOKEN|CLOUDFLARE_ACCESS_AUD/);
  assert.equal(fr.checkout.shippingAddress, "Adresse de livraison");
  assert.equal(en.checkout.shippingAddress, "Shipping address");
  assert.equal(fr.checkout.billingAddress, "Adresse de facturation");
  assert.equal(en.checkout.billingAddress, "Billing address");
  assert.equal(fr.checkout.contactDetails, "E-mail *");
  assert.equal(en.checkout.contactDetails, "Email *");
  assert.equal(fr.checkout.confirmAndPay, "KONFIRM & PAY");
  assert.equal(en.checkout.confirmAndPay, "KONFIRM & PAY");
});

test("the production checkout contains no temporary diagnostic surface", () => {
  const source = readFileSync("app/public/checkout-elements-payment.tsx", "utf8");

  for (const diagnosticToken of [
    "ktdebug",
    "CheckoutElementsDebugPanel",
    "confirmStep",
    "confirmErrorType",
    "confirmResultType",
    "confirmStripeErrorType",
    "confirmStripeErrorCode",
    "confirmStripeDeclineCode",
    "confirmStripeErrorMessage",
  ]) {
    assert.doesNotMatch(source, new RegExp(diagnosticToken));
  }
});

test("a rejected Stripe confirmation keeps the manual recovery path without automatic retry", () => {
  const source = readFileSync("app/public/checkout-elements-payment.tsx", "utf8");
  const confirm = source.indexOf('await actions.confirm({ redirect: "always" })');
  const catchStart = source.indexOf("} catch {", confirm);
  const finallyStart = source.indexOf("} finally {", catchStart);
  const catchSource = source.slice(catchStart, finallyStart);
  const finallySource = source.slice(finallyStart, source.indexOf("\n    }\n  }", finallyStart));

  assert.ok(confirm >= 0 && catchStart > confirm && finallyStart > catchStart);
  assert.match(catchSource, /status: "error" as const/);
  assert.match(catchSource, /validatedAddressRevision: null/);
  assert.match(catchSource, /dictionary\.checkout\.paymentError/);
  assert.doesNotMatch(catchSource, /actions\.confirm|setTimeout|console\./);
  assert.match(finallySource, /shippingElementLifecycle\.restoreAfterFailure\(\)/);
  assert.equal(source.match(/actions\.confirm\(\{ redirect: "always" \}\)/gu)?.length, 1);
});
