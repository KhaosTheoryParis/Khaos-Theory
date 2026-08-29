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

test("catalog prices and product, size, and quantity validation remain unchanged", () => {
  const source = readFileSync("app/api/create-checkout-session/route.ts", "utf8");

  assert.match(source, /geometry: \{ name: "Geometry", amount: 25000 \}/);
  assert.match(source, /"carved-cross": \{ name: "Karved Kross", amount: 20000 \}/);
  assert.match(source, /"damaged-ring-ii": \{ name: "Damaged Ring II", amount: 15000 \}/);
  assert.match(source, /!product \|\| !Number\.isInteger\(quantity\) \|\| quantity < 1 \|\| quantity > 5/);
  assert.match(source, /!Number\.isInteger\(size\) \|\| size < 48 \|\| size > 70/);
  assert.match(source, /checkoutRedirectUrls\(env\.SITE_URL, localeResult\.locale\)/);
  assert.match(source, /if \(!localeResult\.ok\)[\s\S]*Invalid checkout locale\.[\s\S]*status: 400/);
  assert.doesNotMatch(source, /body\.(success_url|cancel_url|return_url|redirect_url|origin)/);
});
