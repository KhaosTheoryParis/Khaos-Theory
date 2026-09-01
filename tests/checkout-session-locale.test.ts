import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { checkoutRedirectUrls, resolveCheckoutLocale } from "../app/services/checkout-locale";

test("checkout locale accepts an absent property as historical French and accepts only fr or en", () => {
  assert.deepEqual(resolveCheckoutLocale({ items: [] }), { ok: true, locale: "fr" });
  assert.deepEqual(resolveCheckoutLocale({ locale: "fr" }), { ok: true, locale: "fr" });
  assert.deepEqual(resolveCheckoutLocale({ locale: "en" }), { ok: true, locale: "en" });

  for (const locale of ["de", "FR", "", null, 1, {}, [], false]) {
    assert.deepEqual(resolveCheckoutLocale({ locale }), { ok: false });
  }
});

test("Stripe redirect URLs use only server SITE_URL and the validated locale", () => {
  const siteUrl = "https://khaostheoryparis.com";

  assert.deepEqual(checkoutRedirectUrls(siteUrl, "fr"), {
    successUrl: "https://khaostheoryparis.com/fr/success?session_id={CHECKOUT_SESSION_ID}",
    cancelUrl: "https://khaostheoryparis.com/fr/checkout",
  });
  assert.deepEqual(checkoutRedirectUrls(siteUrl, "en"), {
    successUrl: "https://khaostheoryparis.com/en/success?session_id={CHECKOUT_SESSION_ID}",
    cancelUrl: "https://khaostheoryparis.com/en/checkout",
  });
  assert.match(checkoutRedirectUrls(siteUrl, "fr").successUrl, /\{CHECKOUT_SESSION_ID\}$/);
});

test("client-supplied redirect fields cannot influence Stripe destinations", () => {
  const maliciousBody = {
    locale: "en",
    success_url: "https://evil.example/success",
    cancel_url: "https://evil.example/cancel",
    return_url: "https://evil.example/return",
    redirect_url: "https://evil.example/redirect",
    origin: "https://evil.example",
  };
  const locale = resolveCheckoutLocale(maliciousBody);
  assert.deepEqual(locale, { ok: true, locale: "en" });
  if (!locale.ok) assert.fail("valid locale was rejected");

  const urls = checkoutRedirectUrls("https://server.example", locale.locale);
  assert.deepEqual(urls, {
    successUrl: "https://server.example/en/success?session_id={CHECKOUT_SESSION_ID}",
    cancelUrl: "https://server.example/en/checkout",
  });
  assert.doesNotMatch(JSON.stringify(urls), /evil\.example/);
});

test("catalog prices and product, size, and quantity validation remain server-side", () => {
  const catalogSource = readFileSync("app/services/checkout-catalog.ts", "utf8");
  const routeSource = readFileSync("app/api/create-checkout-session/route.ts", "utf8");
  const handlerSource = readFileSync("app/services/checkout-elements-http.ts", "utf8");

  assert.match(catalogSource, /geometry: \{ name: "Geometry", amount: 25_000 \}/);
  assert.match(catalogSource, /"carved-cross": \{ name: "Karved Kross", amount: 20_000 \}/);
  assert.match(catalogSource, /"damaged-ring-ii": \{ name: "Damaged Ring II", amount: 15_000 \}/);
  assert.match(catalogSource, /quantity < 1[\s\S]*quantity > CHECKOUT_MAX_QUANTITY/);
  assert.match(catalogSource, /size < CHECKOUT_MIN_SIZE[\s\S]*size > CHECKOUT_MAX_SIZE/);
  assert.match(handlerSource, /resolveCheckoutLocale\(parsedBody\.body\)/);
  assert.match(handlerSource, /if \(!localeResult\.ok\)[\s\S]*Invalid checkout locale\.[\s\S]*400/);
  assert.doesNotMatch(
    `${routeSource}\n${handlerSource}`,
    /parsedBody\.body\.(success_url|cancel_url|return_url|redirect_url|origin)/,
  );
});
