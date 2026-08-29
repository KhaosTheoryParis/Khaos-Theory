import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import LocalizedSuccessPage from "../app/[locale]/success/page";
import { en, fr } from "../app/i18n";
import { isLocale } from "../app/i18n/config";
import { switchLocalizedRoute } from "../app/i18n/routes";

async function renderSuccess(locale: "fr" | "en", sessionId?: string | string[]) {
  return renderToStaticMarkup(await LocalizedSuccessPage({
    params: Promise.resolve({ locale }),
    searchParams: Promise.resolve(sessionId === undefined ? {} : { session_id: sessionId }),
  }));
}

test("localized success routes render their dictionary copy and localized return links", async () => {
  const frHtml = await renderSuccess("fr");
  const enHtml = await renderSuccess("en");

  assert.match(frHtml, new RegExp(fr.success.title));
  assert.match(frHtml, new RegExp(fr.success.message));
  assert.match(frHtml, /href="\/fr"/);
  assert.match(enHtml, new RegExp(en.success.title));
  assert.match(enHtml, new RegExp(en.success.message));
  assert.match(enHtml, /href="\/en"/);
});

test("a missing session_id is accepted without becoming payment authority", async () => {
  const html = await renderSuccess("fr");

  assert.doesNotMatch(html, /session_id=/);
  assert.doesNotMatch(html, /payment succeeded|paiement validé/i);
});

test("a safe single session_id is preserved only for localized language navigation", async () => {
  const html = await renderSuccess("fr", "cs_test_abc123");

  assert.match(html, /href="\/fr\/success\?session_id=cs_test_abc123"/);
  assert.match(html, /href="\/en\/success\?session_id=cs_test_abc123"/);
  assert.doesNotMatch(html, />cs_test_abc123</);
  assert.equal(switchLocalizedRoute("/fr/success?session_id=cs_test_abc123", "en"), "/en/success?session_id=cs_test_abc123");
  assert.equal(switchLocalizedRoute("/en/success?session_id=cs_test_abc123", "fr"), "/fr/success?session_id=cs_test_abc123");
});

test("invalid locales and unsafe or duplicate session_id values cannot create a localized success page state", async () => {
  assert.equal(isLocale("de"), false);
  const unsafe = await renderSuccess("en", "https://example.test");
  const duplicate = await renderSuccess("en", ["cs_test_a", "cs_test_b"]);

  assert.doesNotMatch(unsafe, /session_id=/);
  assert.doesNotMatch(duplicate, /session_id=/);
});

test("the localized success page performs no API, Stripe, or localStorage work", () => {
  const source = readFileSync("app/[locale]/success/page.tsx", "utf8");

  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /\bstripe\b/i);
  assert.doesNotMatch(source, /localStorage|khaosTheoryCart/);
  assert.match(source, /safeSessionId/);
});
