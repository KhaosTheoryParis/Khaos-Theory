import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import LocalizedCategoryPage from "../app/[locale]/[category]/page";
import { en, fr } from "../app/i18n";
import { isLocale } from "../app/i18n/config";
import { switchLocalizedRoute } from "../app/i18n/routes";
import { isPublicCategory, publicCategories } from "../app/public/category-page";
import { homeCatalog } from "../app/public/home-catalog";

async function renderCategory(locale: "fr" | "en", category: (typeof publicCategories)[number]) {
  return renderToStaticMarkup(await LocalizedCategoryPage({ params: Promise.resolve({ locale, category }) }));
}

test("every localized category route renders the matching localized category", async () => {
  for (const [locale, dictionary] of [["fr", fr], ["en", en]] as const) {
    for (const category of publicCategories) {
      const html = await renderCategory(locale, category);

      assert.match(html, new RegExp(`<h1[^>]*>${dictionary.categories[category]}</h1>`));
      assert.match(html, new RegExp(`href="/${locale === "fr" ? "en" : "fr"}/${category}"`));
    }
  }
});

test("localized rings preserve every product ID and link to the matching localized product", async () => {
  const html = await renderCategory("en", "rings");

  assert.equal((html.match(/class="product-card"/g) ?? []).length, homeCatalog.length);
  for (const product of homeCatalog) {
    assert.match(html, new RegExp(`href="/en/product\\?item=${product.id}"`));
    assert.match(html, new RegExp(en.home.products[product.id].name));
  }
  assert.match(html, /Karved Kross/);
  assert.match(html, /Hollow Kross/);
  assert.match(html, /Signet Korner/);
});

test("the empty localized categories retain their translated coming-soon message", async () => {
  const frHtml = await renderCategory("fr", "bracelets");
  const enHtml = await renderCategory("en", "pendants");

  assert.match(frHtml, new RegExp(fr.categories.comingSoon));
  assert.match(enHtml, new RegExp(en.categories.comingSoon));
  assert.doesNotMatch(frHtml, /class="product-card"/);
  assert.doesNotMatch(enHtml, /class="product-card"/);
});

test("locale switching preserves an equivalent localized category route", () => {
  assert.equal(switchLocalizedRoute("/fr/rings", "en"), "/en/rings");
  assert.equal(switchLocalizedRoute("/en/bracelets", "fr"), "/fr/bracelets");
  assert.equal(switchLocalizedRoute("/fr/pendants#collection", "en"), "/en/pendants#collection");
});

test("only supported locales and known category slugs are accepted", () => {
  assert.equal(isLocale("de"), false);
  assert.equal(isLocale("xyz"), false);
  assert.equal(isPublicCategory("rings"), true);
  assert.equal(isPublicCategory("unknown"), false);
});
