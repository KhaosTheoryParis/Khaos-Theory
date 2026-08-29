import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import LocalizedHomePage from "../app/[locale]/page";
import { en, fr } from "../app/i18n";
import { homeCatalog } from "../app/public/home-catalog";
import PublicHeader from "../app/public/public-header";

async function renderHome(locale: "fr" | "en") {
  return renderToStaticMarkup(await LocalizedHomePage({ params: Promise.resolve({ locale }) }));
}

test("the French localized home renders its dictionary content and localized navigation", async () => {
  const html = await renderHome("fr");

  assert.match(html, new RegExp(fr.home.constructionTitle));
  assert.match(html, new RegExp(fr.home.tagline));
  assert.match(html, new RegExp(fr.home.scrollCue));
  assert.match(html, /href="\/fr\/#home"/);
  assert.match(html, /href="\/en"/);
  assert.match(html, /href="\/fr\/checkout"/);
  assert.match(html, /href="\/fr\/contact"/);
  assert.doesNotMatch(html, /href="\/contact\.html"/);
});

test("the English localized home renders English dictionary content and a working switcher", async () => {
  const html = await renderHome("en");

  assert.match(html, new RegExp(en.home.constructionTitle));
  assert.match(html, new RegExp(en.home.tagline));
  assert.match(html, /href="\/en\/#home"/);
  assert.match(html, /href="\/fr"/);
  assert.match(html, /aria-current="page"[^>]*>English/);
  assert.match(html, /href="\/en\/contact"/);
  assert.doesNotMatch(html, /href="\/contact\.html"/);
});

test("home product cards retain catalog IDs, brand names and localized product destinations", async () => {
  const html = await renderHome("en");

  assert.equal((html.match(/class="product-card"/g) ?? []).length, homeCatalog.length);
  for (const product of homeCatalog) {
    assert.match(html, new RegExp(en.home.products[product.id].name));
    assert.match(html, new RegExp(`href="/en/product\\?item=${product.id}"`));
  }
  assert.match(html, /Karved Kross/);
  assert.match(html, /Hollow Kross/);
  assert.match(html, /Signet Korner/);
  assert.match(html, /href="\/en\/checkout"/);
});

test("the shared header uses semantic navigation, a native collection disclosure and real links", () => {
  const html = renderToStaticMarkup(createElement(PublicHeader, { locale: "fr" }));

  assert.match(html, /<header>/);
  assert.match(html, /<nav[^>]*aria-label="KOLLECTION"/);
  assert.match(html, /<details class="collection-menu">/);
  assert.match(html, /<summary class="collection-toggle">KOLLECTION<\/summary>/);
  assert.match(html, new RegExp(fr.navigation.rings));
  assert.match(html, /href="\/fr\/rings"/);
  assert.match(html, /href="\/fr\/bracelets"/);
  assert.match(html, /href="\/fr\/earrings"/);
  assert.match(html, /href="\/fr\/pendants"/);
  assert.match(html, /href="\/fr\/about"/);
  assert.match(html, /href="\/fr\/contact"/);
  assert.match(html, /href="\/fr\/checkout"/);
});
