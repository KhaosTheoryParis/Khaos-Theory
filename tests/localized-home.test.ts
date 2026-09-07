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

test("the shared cart icon exposes a total-quantity badge from the persisted cart source", () => {
  const source = readFileSync("app/public/public-header.tsx", "utf8");
  const cartSource = readFileSync("app/public/historical-cart.ts", "utf8");
  const css = readFileSync("app/[locale]/localized-home.css", "utf8");

  assert.match(source, /const nextCart = readHistoricalCart\(window\.localStorage\)/);
  assert.match(source, /setCartQuantity\(totalHistoricalCartQuantity\(nextCart\)\)/);
  assert.match(source, /subscribeToHistoricalCart\(refreshCart\)/);
  assert.match(source, /cartQuantity > 0 \? <span className="cart-quantity-badge"/);
  assert.match(source, /locale === "fr" \? "Mon Panier" : "My Kart"/);
  assert.match(source, /className="cart-checkout-link"/);
  assert.match(cartSource, /HISTORICAL_CART_CHANGE_EVENT/);
  assert.match(cartSource, /totalHistoricalCartQuantity/);
  assert.match(css, /\.cart-quantity-badge\s*\{/);
  assert.match(css, /\.cart-submenu \.cart-checkout-link\s*\{/);
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

test("checkout spacing stays compact while preserving a full-size payment target", () => {
  const css = readFileSync("app/[locale]/localized-home.css", "utf8");

  assert.match(css, /\.localized-public \.checkout-elements \{[\s\S]*?margin-top: 14px;/);
  assert.match(css, /\.localized-public \.stripe-element-section \{[\s\S]*?margin: 14px 0 0;[\s\S]*?padding: 12px;/);
  assert.match(css, /\.localized-public \.stripe-checkout-button \{\s*margin-top: 14px;/);
  assert.match(css, /\.localized-public \.checkout-terms-acceptance \{[\s\S]*?min-height: 44px;/);
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*?\.localized-public \.checkout-summary \{\s*padding: 118px 16px 30px;/);
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*?\.localized-public \.stripe-element-section \{\s*padding: 10px 12px;[\s\S]*?margin-top: 12px;/);
  assert.match(css, /\.localized-public \.stripe-checkout-button:disabled/);
});

test("localized French and English homepages retain the animated scroll cue", () => {
  const css = readFileSync("app/[locale]/localized-home.css", "utf8");

  assert.match(css, /\.localized-public \.scroll::after\s*\{[\s\S]*?animation: scroll-cue 1\.5s ease-in-out infinite;/);
  assert.match(css, /@keyframes scroll-cue[\s\S]*?transform: translateY\(6px\) rotate\(45deg\);/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

test("reduced motion leaves the scroll cue still and in its neutral position", () => {
  const css = readFileSync("app/[locale]/localized-home.css", "utf8");

  assert.match(css, /\.localized-public \.scroll::after\s*\{\s*animation: none !important;\s*opacity: 0\.35;\s*transform: translateY\(0\) rotate\(45deg\);/);
});

test("the language selector closes outside the menu and keeps a borderless focusable control", () => {
  const source = readFileSync("app/public/public-header.tsx", "utf8");
  const css = readFileSync("app/[locale]/localized-home.css", "utf8");
  const summaryStyles = css.match(/\.localized-public \.language-menu summary \{[\s\S]*?\}/)?.[0] ?? "";

  assert.match(source, /document\.addEventListener\("pointerdown"/);
  assert.match(source, /languageMenuRef\.current\?\.contains\(event\.target as Node\)/);
  assert.match(source, /event\.key !== "Escape"/);
  assert.match(summaryStyles, /border:\s*0/);
  assert.match(source, /<summary aria-label=\{dictionary\.language\.switcherLabel\}>/);
});
