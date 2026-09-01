import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { resolveNotFoundLocale } from "../app/[locale]/not-found";
import { defaultLocale } from "../app/i18n/config";
import { en, fr } from "../app/i18n";
import PublicNotFound from "../app/public/public-not-found";
import sitemap from "../app/sitemap";

function renderNotFound(locale: "fr" | "en") {
  return renderToStaticMarkup(createElement(PublicNotFound, { locale }));
}

test("localized 404 content is French or English and returns to the matching home page", () => {
  const frHtml = renderNotFound("fr");
  const enHtml = renderNotFound("en");

  assert.match(frHtml, new RegExp(fr.notFound.title));
  assert.match(frHtml, new RegExp(fr.notFound.message));
  assert.match(frHtml, /href="\/fr"/);
  assert.match(enHtml, new RegExp(en.notFound.title));
  assert.match(enHtml, new RegExp(en.notFound.message));
  assert.match(enHtml, /href="\/en"/);
});

test("localized 404 resolves only supported locales and preserves semantic keyboard navigation", () => {
  const source = readFileSync("app/[locale]/not-found.tsx", "utf8");
  const frHtml = renderNotFound("fr");

  assert.equal(resolveNotFoundLocale("fr"), "fr");
  assert.equal(resolveNotFoundLocale("en"), "en");
  assert.equal(resolveNotFoundLocale("unknown"), defaultLocale);
  assert.match(source, /useParams/);
  assert.match(frHtml, /<main class="not-found-main">/);
  assert.match(frHtml, /<h1 id="not-found-title"/);
  assert.match(frHtml, /class="not-found-home-link" href="\/fr"/);
});

test("404 remains outside the sitemap and does not expose implementation details", () => {
  const html = `${renderNotFound("fr")} ${renderNotFound("en")}`;

  assert.equal(sitemap().some((entry) => entry.url.includes("not-found")), false);
  assert.doesNotMatch(html, /stack trace|error digest|undefined/i);
});

test("404 styling remains responsive and keeps the return link visibly focusable", () => {
  const css = readFileSync("app/[locale]/localized-home.css", "utf8");

  assert.match(css, /\.localized-public\.localized-not-found-page/);
  assert.match(css, /\.not-found-home-link:focus-visible/);
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*\.not-found-main/);
});
