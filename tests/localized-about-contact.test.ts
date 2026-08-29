import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import LocalizedAboutPage from "../app/[locale]/about/page";
import LocalizedContactPage from "../app/[locale]/contact/page";
import { en, fr } from "../app/i18n";
import { isLocale } from "../app/i18n/config";
import { switchLocalizedRoute } from "../app/i18n/routes";

async function renderAbout(locale: "fr" | "en") {
  return renderToStaticMarkup(await LocalizedAboutPage({ params: Promise.resolve({ locale }) }));
}

async function renderContact(locale: "fr" | "en") {
  return renderToStaticMarkup(await LocalizedContactPage({ params: Promise.resolve({ locale }) }));
}

test("all four localized About and Kontact routes render their French or English dictionary copy", async () => {
  const frAbout = await renderAbout("fr");
  const enAbout = await renderAbout("en");
  const frContact = await renderContact("fr");
  const enContact = await renderContact("en");

  assert.match(frAbout, new RegExp(fr.about.message));
  assert.match(enAbout, new RegExp(en.about.message));
  assert.match(frContact, new RegExp(fr.contact.title));
  assert.match(enContact, new RegExp(en.contact.title));
  assert.equal(isLocale("de"), false);
});

test("localized header navigation and language switching keep About and Kontact localized", async () => {
  const html = await renderAbout("fr");

  assert.match(html, /href="\/fr\/about"/);
  assert.match(html, /href="\/fr\/contact"/);
  assert.match(html, /href="\/en\/about"/);
  assert.equal(switchLocalizedRoute("/fr/about", "en"), "/en/about");
  assert.equal(switchLocalizedRoute("/en/contact", "fr"), "/fr/contact");
});

test("the localized Kontact page preserves the historical mailto address exactly", async () => {
  const historical = readFileSync("public/contact.html", "utf8");
  const html = await renderContact("fr");

  assert.match(historical, /mailto:contact@khaostheoryparis\.com/);
  assert.match(html, /href="mailto:contact@khaostheoryparis\.com"/);
  assert.match(html, />contact@khaostheoryparis\.com</);
});
