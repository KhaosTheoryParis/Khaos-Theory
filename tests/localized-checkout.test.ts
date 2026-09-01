import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import LocalizedCheckoutPage from "../app/[locale]/checkout/page";
import { en, fr } from "../app/i18n";
import { switchLocalizedRoute } from "../app/i18n/routes";
import {
  changeCheckoutQuantity,
  checkoutDisplayLine,
  checkoutSessionItems,
  checkoutTotal,
  isCheckoutItemValid,
  localizedCheckoutSessionPayload,
  MAX_CART_QUANTITY,
  removeCheckoutItem,
} from "../app/public/checkout-cart";
import { HISTORICAL_CART_STORAGE_KEY, type HistoricalCartItem } from "../app/public/historical-cart";

async function renderCheckout(locale: "fr" | "en") {
  return renderToStaticMarkup(await LocalizedCheckoutPage({ params: Promise.resolve({ locale }) }));
}

const cart: HistoricalCartItem[] = [
  { key: "geometry-48", productId: "geometry", name: "Old name", price: 1, size: 48, usSize: "4.5", quantity: 1 },
  { key: "hollow-cross-58", productId: "hollow-cross", name: "Hollow Kross", price: 200, size: 58, usSize: "8.5", quantity: 2 },
];

test("localized checkout routes render French and English labels with localized header links", async () => {
  const frHtml = await renderCheckout("fr");
  const enHtml = await renderCheckout("en");

  assert.match(frHtml, new RegExp(fr.checkout.yourKart));
  assert.match(frHtml, new RegExp(fr.checkout.loading));
  assert.match(frHtml, /href="\/fr\/checkout"/);
  assert.match(enHtml, new RegExp(en.checkout.yourKart));
  assert.match(enHtml, new RegExp(en.checkout.loading));
  assert.match(enHtml, /href="\/en\/checkout"/);
});

test("checkout display resolves known product names and prices from the current catalog", () => {
  const line = checkoutDisplayLine(cart[0], en);

  assert.equal(line.name, "Geometry");
  assert.equal(line.price, 250);
  assert.equal(line.lineTotal, 250);
  assert.equal(checkoutTotal(cart, en), 650);
});

test("an unknown historical product falls back safely without breaking the checkout", () => {
  const unknown: HistoricalCartItem = {
    key: "legacy-48", productId: "legacy-product", name: "Legacy piece", price: 123, size: 48, usSize: "4.5", quantity: 1,
  };
  const line = checkoutDisplayLine(unknown, fr);

  assert.equal(line.name, "Legacy piece");
  assert.equal(line.price, 123);
  assert.equal(isCheckoutItemValid(unknown), false);
});

test("checkout quantity changes preserve the historical cart identity and the one-to-five limit", () => {
  const increased = changeCheckoutQuantity(cart, "geometry-48", 1);
  assert.equal(increased[0].key, "geometry-48");
  assert.equal(increased[0].productId, "geometry");
  assert.equal(increased[0].quantity, 2);

  const capped = changeCheckoutQuantity([{ ...cart[0], quantity: MAX_CART_QUANTITY }], "geometry-48", 1);
  assert.equal(capped[0].quantity, MAX_CART_QUANTITY);

  const removedByDecrement = changeCheckoutQuantity([{ ...cart[0], quantity: 1 }], "geometry-48", -1);
  assert.deepEqual(removedByDecrement, []);
  assert.deepEqual(removeCheckoutItem(cart, "geometry-48"), [cart[1]]);
});

test("the localized checkout adds only its validated locale to the existing item contract", () => {
  assert.deepEqual(checkoutSessionItems(cart), [
    { productId: "geometry", size: 48, quantity: 1 },
    { productId: "hollow-cross", size: 58, quantity: 2 },
  ]);
  assert.equal(HISTORICAL_CART_STORAGE_KEY, "khaosTheoryCart");
  assert.deepEqual(localizedCheckoutSessionPayload(cart, "fr"), {
    items: checkoutSessionItems(cart),
    locale: "fr",
  });
  assert.deepEqual(localizedCheckoutSessionPayload(cart, "en"), {
    items: checkoutSessionItems(cart),
    locale: "en",
  });
  assert.deepEqual(Object.keys(localizedCheckoutSessionPayload(cart, "fr")).sort(), ["items", "locale"]);

  const httpSource = readFileSync("app/services/checkout-elements-http.ts", "utf8");
  const catalogSource = readFileSync("app/services/checkout-catalog.ts", "utf8");
  const elementsSource = readFileSync("app/services/stripe-checkout-elements.ts", "utf8");
  assert.match(catalogSource, /type ValidatedCheckoutItem/);
  assert.match(catalogSource, /quantity < 1[\s\S]*quantity > CHECKOUT_MAX_QUANTITY/);
  assert.match(elementsSource, /ui_mode: "elements"/);
  assert.match(elementsSource, /return_url: checkoutElementsReturnUrl/);
  assert.doesNotMatch(elementsSource, /success_url:|cancel_url:/);
  assert.match(httpSource, /prepareCheckoutElementsCart\(parsedBody\.body\.items/);
});

test("the checkout LanguageSwitcher preserves the cart and swaps only the localized route", () => {
  assert.equal(switchLocalizedRoute("/fr/checkout", "en"), "/en/checkout");
  assert.equal(switchLocalizedRoute("/en/checkout", "fr"), "/fr/checkout");
});

test("French and English preserve complete Checkout and Legal dictionary parity", () => {
  assert.deepEqual(Object.keys(fr.checkout).sort(), Object.keys(en.checkout).sort());
  assert.deepEqual(Object.keys(fr.legal).sort(), Object.keys(en.legal).sort());
});

test("checkout keeps its cart on a local persistence failure and exposes only a recoverable message", () => {
  const source = readFileSync("app/public/checkout-client.tsx", "utf8");

  assert.match(source, /try \{\s*writeHistoricalCart\(window\.localStorage, nextCart\);/);
  assert.match(source, /setCartError\(dictionary\.checkout\.cartUpdateError\)/);
  assert.match(source, /checkout-status checkout-status--error" role="alert"/);
  assert.match(source, /if \(cart\.length === 0\)[\s\S]*?continueShopping/);
});
