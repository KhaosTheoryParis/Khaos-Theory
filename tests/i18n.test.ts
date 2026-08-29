import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { defaultLocale, isLocale, supportedLocales } from "../app/i18n/config";
import { dictionaries, getDictionary } from "../app/i18n";
import {
  localizedHref,
  localizedPath,
  parseLocalizedRoute,
  switchLocalizedRoute,
} from "../app/i18n/routes";

test("only fr and en are valid locales and French is the default", () => {
  assert.deepEqual(supportedLocales, ["fr", "en"]);
  assert.equal(defaultLocale, "fr");
  assert.equal(isLocale("fr"), true);
  assert.equal(isLocale("en"), true);
  assert.equal(isLocale("de"), false);
  assert.equal(isLocale(undefined), false);
});

test("the typed dictionaries expose the same top-level sections", () => {
  assert.deepEqual(Object.keys(dictionaries.fr).sort(), Object.keys(dictionaries.en).sort());
  assert.deepEqual(Object.keys(dictionaries.fr.navigation).sort(), Object.keys(dictionaries.en.navigation).sort());
  assert.deepEqual(Object.keys(dictionaries.fr.language).sort(), Object.keys(dictionaries.en.language).sort());
  assert.equal(getDictionary("fr").navigation.collection, "KOLLECTION");
  assert.equal(getDictionary("en").navigation.cart, "MY KART");
});

test("localized route generation uses only known internal routes", () => {
  assert.equal(localizedPath("fr", "home"), "/fr");
  assert.equal(localizedPath("en", "rings"), "/en/rings");
  assert.equal(localizedHref("fr", "product", { query: { item: "geometry" } }), "/fr/product?item=geometry");
  assert.equal(localizedHref("en", "success", { query: { session_id: "abc" } }), "/en/success?session_id=abc");
  assert.equal(localizedHref("en", "home", { hash: "home" }), "/en/#home");
});

test("a locale switch preserves product and checkout query parameters plus anchors", () => {
  assert.equal(
    switchLocalizedRoute("/fr/product?item=geometry", "en"),
    "/en/product?item=geometry",
  );
  assert.equal(
    switchLocalizedRoute("/fr/success?session_id=abc", "en"),
    "/en/success?session_id=abc",
  );
  assert.equal(switchLocalizedRoute("/fr/#home", "en"), "/en/#home");
  assert.equal(
    switchLocalizedRoute("/en/product?item=hollow-cross#details", "fr"),
    "/fr/product?item=hollow-cross#details",
  );
});

test("only known internal localized destinations can be parsed or switched", () => {
  assert.equal(parseLocalizedRoute("https://example.test/fr/product?item=geometry"), null);
  assert.equal(parseLocalizedRoute("//example.test/fr/product"), null);
  assert.equal(parseLocalizedRoute("/fr/unknown"), null);
  assert.equal(parseLocalizedRoute("product?item=geometry"), null);
  assert.equal(switchLocalizedRoute("https://example.test/fr/product", "en"), null);
});

test("the document architecture gives localized routes their own server root layout", () => {
  const localeLayout = readFileSync("app/[locale]/layout.tsx", "utf8");
  const adminLayout = readFileSync("app/admin/layout.tsx", "utf8");

  assert.match(localeLayout, /<html lang=\{locale\}>/);
  assert.match(localeLayout, /if \(!isLocale\(locale\)\) notFound\(\)/);
  assert.match(adminLayout, /<html lang="fr">/);
});
