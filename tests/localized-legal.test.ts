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
  const frHtml = await renderLegal("fr");
  const enHtml = await renderLegal("en");
  const html = `${frHtml} ${enHtml}`;

  assert.match(html, /EI - Vincent GÉRARD/);
  assert.match(html, /Khaos Theory/);
  assert.match(html, /231 Rue Saint-Honoré/);
  assert.match(html, /75001 Paris/);
  assert.match(html, /928 374 297/);
  assert.match(html, /928 374 297 00028/);
  assert.match(html, /mailto:contact@khaostheoryparis\.com/);
  assert.match(html, /Cloudflare, Inc\./);
  assert.match(html, /101 Townsend St/);
  assert.match(frHtml, /01 84 16 47 78/);
  assert.match(enHtml, /\+33 1 84 16 47 78/);
  assert.match(html, /href="tel:\+33184164778"/);
});

test("both language versions identify CM2C and its official referral website", async () => {
  const frHtml = await renderLegal("fr");
  const enHtml = await renderLegal("en");

  for (const html of [frHtml, enHtml]) {
    assert.match(html, /CM2C/);
    assert.match(html, /Centre de la Médiation de la Consommation de Conciliateurs de Justice/);
    assert.match(html, /49 Rue de Ponthieu/);
    assert.match(html, /75008 Paris/);
    assert.match(html, /href="https:\/\/www\.cm2c\.net\/"/);
  }

  assert.match(frHtml, /le consommateur peut recourir gratuitement au médiateur de la consommation/);
  assert.match(enHtml, /consumers may refer their dispute free of charge to the consumer mediator/);
  assert.match(enHtml, /French version prevails/);
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

test("legal notices contain no obsolete, placeholder or invented identifiers", async () => {
  const html = `${await renderLegal("fr")} ${await renderLegal("en")}`;

  assert.doesNotMatch(html, /GitHub Pages/i);
  assert.doesNotMatch(html, /à compléter|to be completed|placeholder/i);
  assert.doesNotMatch(html, /(?:n°|numéro)\s+(?:d’adhésion|d'adhésion|de convention|de dossier)/i);
  assert.doesNotMatch(html, /(?:membership|agreement|case)\s+(?:number|reference)/i);
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
