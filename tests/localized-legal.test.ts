import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import LocalizedLegalPage from "../app/[locale]/legal/page";
import { GET as redirectLegacyLegal } from "../app/legal/route";
import { en, fr } from "../app/i18n";
import { switchLocalizedRoute } from "../app/i18n/routes";

async function renderLegal(locale: "fr" | "en") {
  return renderToStaticMarkup(await LocalizedLegalPage({ params: Promise.resolve({ locale }) }));
}

test("the French and English legal routes render their localized legal notice", async () => {
  const frHtml = await renderLegal("fr");
  const enHtml = await renderLegal("en");

  assert.match(frHtml, new RegExp(fr.legal.title));
  assert.match(frHtml, /Éditeur du site/);
  assert.match(frHtml, /franchise en base de TVA/);
  assert.match(enHtml, new RegExp(en.legal.title));
  assert.match(enHtml, /Website publisher/);
  assert.match(enHtml, /French VAT exemption scheme/);
});

test("both language versions contain the supplied facts and the approved Cloudflare host", async () => {
  const html = `${await renderLegal("fr")} ${await renderLegal("en")}`;

  assert.match(html, /EI - Vincent GÉRARD/);
  assert.match(html, /Khaos Theory/);
  assert.match(html, /231 Rue Saint-Honoré/);
  assert.match(html, /75001 Paris/);
  assert.match(html, /928 374 297/);
  assert.match(html, /928 374 297 00028/);
  assert.match(html, /mailto:contact@khaostheoryparis\.com/);
  assert.match(html, /Cloudflare, Inc\./);
  assert.match(html, /101 Townsend St/);
});

test("localized layout, footer and LanguageSwitcher preserve the legal route", async () => {
  const frHtml = await renderLegal("fr");
  const enHtml = await renderLegal("en");
  const localizedLayout = readFileSync("app/[locale]/layout.tsx", "utf8");

  assert.match(localizedLayout, /<html lang=\{locale\}>/);
  assert.match(frHtml, /href="\/fr\/legal"/);
  assert.match(frHtml, /href="\/en\/legal"/);
  assert.match(enHtml, /href="\/en\/legal"/);
  assert.equal(switchLocalizedRoute("/fr/legal", "en"), "/en/legal");
  assert.equal(switchLocalizedRoute("/en/legal", "fr"), "/fr/legal");
});

test("legal notices contain no obsolete, placeholder or invented contact information", async () => {
  const html = `${await renderLegal("fr")} ${await renderLegal("en")}`;

  assert.doesNotMatch(html, /GitHub Pages/i);
  assert.doesNotMatch(html, /à compléter/i);
  assert.doesNotMatch(html, /href="tel:/i);
  assert.doesNotMatch(html, />\s*(?:Téléphone|Phone)\s*</i);
  assert.doesNotMatch(html, /médiateur|mediator/i);
});

test("legacy legal routes use direct HTTP redirects to the localized French legal notice", () => {
  const response = redirectLegacyLegal();
  const redirects = readFileSync("public/_redirects", "utf8");

  assert.equal(response.status, 308);
  assert.equal(response.headers.get("location"), "/fr/legal");
  assert.match(redirects, /^\/legal\s+\/fr\/legal\s+308$/m);
  assert.match(redirects, /^\/legal\.html\s+\/fr\/legal\s+308$/m);
  assert.equal(existsSync("public/legal.html"), false);
});
