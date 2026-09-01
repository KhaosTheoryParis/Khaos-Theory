import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { HISTORICAL_CART_STORAGE_KEY, readHistoricalCart } from "../app/public/historical-cart";

test("all legacy checkout variants redirect directly to the canonical French checkout", () => {
  const redirects = readFileSync("public/_redirects", "utf8");

  assert.match(redirects, /^\/checkout \/fr\/checkout 308$/m);
  assert.match(redirects, /^\/checkout\/ \/fr\/checkout 308$/m);
  assert.match(redirects, /^\/checkout\.html \/fr\/checkout 308$/m);
  assert.match(redirects, /^\/legal \/fr\/legal 308$/m);
  assert.match(redirects, /^\/legal\.html \/fr\/legal 308$/m);
  assert.equal(existsSync("public/checkout.html"), false);
  assert.doesNotMatch(redirects, /^\/fr\/checkout\b/m);
  assert.doesNotMatch(redirects, /\*|:\w+/);
});

test("legacy string ring sizes remain strictly normalized when the localized checkout reads the shared cart", () => {
  const stored = JSON.stringify([{
    key: "geometry-48",
    productId: "geometry",
    name: "Geometry",
    price: 250,
    size: "48",
    usSize: "4.5",
    quantity: 1,
  }]);
  const storage = {
    getItem: (key: string) => key === HISTORICAL_CART_STORAGE_KEY ? stored : null,
    setItem: () => undefined,
    removeItem: () => undefined,
    clear: () => undefined,
    key: () => null,
    length: 1,
  } satisfies Storage;
  assert.equal(readHistoricalCart(storage)[0]?.size, 48);

  for (const invalidSize of [" 48", "48.0", "48x", "047", "71"]) {
    const invalidStorage = {
      ...storage,
      getItem: () => stored.replace('"48"', JSON.stringify(invalidSize)),
    } satisfies Storage;
    assert.deepEqual(readHistoricalCart(invalidStorage), []);
  }
});
