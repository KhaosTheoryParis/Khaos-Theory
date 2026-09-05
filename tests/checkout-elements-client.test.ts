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
  parseElementsSessionConfig,
  runAuthoritativeShippingUpdate,
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
  name: "Test Customer",
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
  assert.match(frHtml, /Paiement sécurisé/);
  assert.match(enHtml, /Shipping address/);
  assert.match(enHtml, /Secure payment/);
  assert.match(frHtml, /checkout-elements--initializing/);
  assert.match(frHtml, /aria-busy="true"/);
  assert.match(frHtml, /<button[^>]*disabled=""/);
  assert.match(enHtml, /<button[^>]*disabled=""/);
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
  assert.doesNotMatch(JSON.stringify(requestBody), /productsSubtotal|shippingAmount|\btotal\b|shippingZone|\bprice\b/);

  let gate = invalidateCheckoutAddress(createCheckoutElementsGate("cart"), true);
  assert.equal(gate.status, "checking");
  gate = finishCheckoutAddressValidation(gate, gate.addressRevision, "eligible");
  assert.equal(gate.status, "eligible");
  assert.equal(canConfirmCheckoutElements(gate, "cart", true), true);
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

test("the FR and EN Elements UI use the modern typed API and no deprecated callback", () => {
  const source = readFileSync("app/public/checkout-elements-payment.tsx", "utf8");
  assert.match(source, /@stripe\/stripe-js\/pure/);
  assert.match(source, /initCheckoutElementsSdk/);
  assert.match(source, /createShippingAddressElement/);
  assert.match(source, /createContactDetailsElement/);
  assert.match(source, /createPaymentElement/);
  assert.match(source, /runServerUpdate/);
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
  assert.equal(fr.checkout.confirmAndPay, "KONFIRM & PAY");
  assert.equal(en.checkout.confirmAndPay, "KONFIRM & PAY");
});
