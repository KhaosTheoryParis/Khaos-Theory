import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  assert.match(html, /aria-current="page"[^>]*>[\s\S]*?<span>English<\/span>/);
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
  assert.match(html, /class="localized-header-bar"/);
  assert.match(html, /<details class="language-menu">/);
  assert.match(html, /🇫🇷/);
  assert.match(html, />FR<\/span>/);
  assert.match(html, /🇬🇧/);
  assert.match(html, /href="\/en" lang="en">/);
});

test("localized public styles keep the header, product details and kart controls compact on narrow screens", () => {
  const css = readFileSync("app/[locale]/localized-home.css", "utf8");

  assert.match(css, /@media \(min-width: 701px\) and \(max-width: 900px\)/);
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*?\.localized-public \.product-overlay[\s\S]*?opacity: 1/);
  assert.match(css, /@media \(max-width: 420px\)[\s\S]*?grid-template-areas:[\s\S]*?"details remove"/);
});

test("localized public styles retain visible focus, readable disabled states and reduced-motion support", () => {
  const css = readFileSync("app/[locale]/localized-home.css", "utf8");

  assert.match(css, /\.localized-public a:focus-visible,[\s\S]*?\.localized-public select:focus-visible/);
  assert.match(css, /\.localized-public footer \{\s*color: #aaa;/);
  assert.match(css, /\.localized-public \.stripe-checkout-button:disabled \{[\s\S]*?opacity: 0\.6;/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});
