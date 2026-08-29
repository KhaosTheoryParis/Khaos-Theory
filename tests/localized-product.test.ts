import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import LocalizedProductPage from "../app/[locale]/product/page";
import { en, fr } from "../app/i18n";
import { isLocale } from "../app/i18n/config";
import { switchLocalizedRoute } from "../app/i18n/routes";
import {
  getPublicProduct,
  isPublicProductId,
  localizedProductHref,
  publicProductCatalog,
  ringSizes,
} from "../app/public/home-catalog";
import {
  addToHistoricalCart,
  HISTORICAL_CART_STORAGE_KEY,
  readHistoricalCart,
  writeHistoricalCart,
} from "../app/public/historical-cart";

async function renderProduct(locale: "fr" | "en", item: string) {
  return renderToStaticMarkup(await LocalizedProductPage({
    params: Promise.resolve({ locale }),
    searchParams: Promise.resolve({ item }),
  }));
}

test("the public product catalog keeps the six immutable IDs, prices, images and ring sizes", () => {
  assert.deepEqual(publicProductCatalog.map(({ id }) => id), [
    "geometry", "carved-cross", "hollow-cross", "signet-corner", "damaged-ring-i", "damaged-ring-ii",
  ]);
  assert.deepEqual(publicProductCatalog.map(({ price }) => price), [250, 200, 200, 200, 150, 150]);
  assert.equal(getPublicProduct("signet-corner")?.images.length, 2);
  assert.deepEqual(ringSizes[0], [48, "4.5"]);
  assert.deepEqual(ringSizes.at(-1), [70, "13"]);
  assert.equal(isPublicProductId("geometry"), true);
  assert.equal(isPublicProductId("invalid-product"), false);
  assert.equal(getPublicProduct("invalid-product"), null);
});

test("localized product pages render French and English copy from the dictionaries", async () => {
  const frHtml = await renderProduct("fr", "geometry");
  const enHtml = await renderProduct("en", "geometry");

  assert.match(frHtml, /<h1[^>]*>Geometry<\/h1>/);
  assert.match(frHtml, new RegExp(fr.product.addToKart));
  assert.match(frHtml, new RegExp(fr.product.size));
  assert.match(enHtml, /<h1[^>]*>Geometry<\/h1>/);
  assert.match(enHtml, new RegExp(en.product.addToKart));
  assert.match(enHtml, new RegExp(en.product.quantity));
});

test("each localized product page preserves brand product names and public catalog values", async () => {
  for (const product of publicProductCatalog) {
    const html = await renderProduct("en", product.id);
    assert.match(html, new RegExp(en.home.products[product.id].name));
    assert.match(html, new RegExp(`<p class="product-price">${product.price} €</p>`));
  }

  const html = await renderProduct("en", "carved-cross");
  assert.match(html, /Karved Kross/);
  assert.doesNotMatch(html, /Carved Cross/);
});

test("the product LanguageSwitcher preserves the exact internal item ID", async () => {
  const html = await renderProduct("fr", "hollow-cross");

  assert.match(html, /href="\/fr\/product\?item=hollow-cross"/);
  assert.match(html, /href="\/en\/product\?item=hollow-cross"/);
  assert.equal(switchLocalizedRoute("/fr/product?item=hollow-cross", "en"), "/en/product?item=hollow-cross");
  assert.equal(localizedProductHref("fr", "geometry"), "/fr/product?item=geometry");
});

test("invalid locales and item IDs are rejected before a product can be rendered", () => {
  assert.equal(isLocale("de"), false);
  assert.equal(getPublicProduct("Geometry"), null);
  assert.equal(getPublicProduct("geometry?price=1"), null);
});

test("new localized cart entries keep the historical khaosTheoryCart format", () => {
  const product = getPublicProduct("geometry");
  assert.ok(product);
  const first = addToHistoricalCart([], { id: product.id, name: "Geometry", price: product.price }, 58, "8.5", 1);

  assert.deepEqual(first, [{
    key: "geometry-58",
    productId: "geometry",
    name: "Geometry",
    price: 250,
    size: 58,
    usSize: "8.5",
    quantity: 1,
  }]);

  const second = addToHistoricalCart(first, { id: product.id, name: "Geometry", price: product.price }, 58, "8.5", 2);
  assert.equal(second.length, 1);
  assert.equal(second[0].quantity, 3);
  assert.equal(HISTORICAL_CART_STORAGE_KEY, "khaosTheoryCart");
  assert.match(readFileSync("public/script.js", "utf8"), /localStorage\.getItem\("khaosTheoryCart"\)/);
});

test("historical cart storage remains readable and writable without a migration", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) { values.set(key, value); },
  } as Storage;
  const cart = [{ key: "geometry-48", productId: "geometry", name: "Geometry", price: 250, size: 48, usSize: "4.5", quantity: 1 }];

  writeHistoricalCart(storage, cart);
  assert.deepEqual(readHistoricalCart(storage), cart);

  storage.setItem(HISTORICAL_CART_STORAGE_KEY, JSON.stringify([...cart, { malformed: true }]));
  assert.deepEqual(readHistoricalCart(storage), cart);
});
