import assert from "node:assert/strict";
import test from "node:test";
import {
  FREE_SHIPPING_THRESHOLD,
  FR_SHIPPING_AMOUNT,
  KNOWN_SHIPPING_ZONES,
  quoteShipping,
} from "../app/services/shipping";

test("French V1 shipping charges the fixed amount below the free-shipping threshold", () => {
  assert.equal(FREE_SHIPPING_THRESHOLD, 40_000);
  assert.equal(FR_SHIPPING_AMOUNT, 1_000);

  assert.deepEqual(quoteShipping(0, "fr"), {
    shippingCountry: "FR",
    shippingZone: "FR",
    shippingAmount: 1_000,
    amountTotal: 1_000,
    currency: "eur",
    label: "Livraison sécurisée",
  });
  assert.equal(quoteShipping(1, "fr").shippingAmount, 1_000);
  assert.equal(quoteShipping(1, "fr").amountTotal, 1_001);
  assert.equal(quoteShipping(39_999, "fr").shippingAmount, 1_000);
  assert.equal(quoteShipping(39_999, "fr").amountTotal, 40_999);
});

test("French V1 shipping is free at and above the threshold", () => {
  assert.equal(quoteShipping(40_000, "fr").shippingAmount, 0);
  assert.equal(quoteShipping(40_000, "fr").amountTotal, 40_000);
  assert.equal(quoteShipping(40_001, "fr").shippingAmount, 0);
  assert.equal(quoteShipping(40_001, "fr").amountTotal, 40_001);
});

test("shipping labels are localized only for supported locales", () => {
  assert.equal(quoteShipping(10_000, "fr").label, "Livraison sécurisée");
  assert.equal(quoteShipping(10_000, "en").label, "Secure shipping");
});

test("shipping rejects invalid subtotals and locales", () => {
  for (const subtotal of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => quoteShipping(subtotal, "fr"), /INVALID_PRODUCTS_SUBTOTAL/);
  }

  for (const locale of ["FR", "de", "", null, 1, {}, []]) {
    assert.throws(() => quoteShipping(10_000, locale), /INVALID_SHIPPING_LOCALE/);
  }
});

test("only France is active and future zones have no implicit world fallback", () => {
  assert.deepEqual(KNOWN_SHIPPING_ZONES, ["FR", "EU", "JP", "KR"]);
  assert.equal(KNOWN_SHIPPING_ZONES.includes("FR"), true);
  assert.equal(KNOWN_SHIPPING_ZONES.includes("EU"), true);
  assert.equal(KNOWN_SHIPPING_ZONES.includes("JP"), true);
  assert.equal(KNOWN_SHIPPING_ZONES.includes("KR"), true);
  assert.equal(KNOWN_SHIPPING_ZONES.includes("WORLD" as never), false);
});
