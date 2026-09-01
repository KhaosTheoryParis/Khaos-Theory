import assert from "node:assert/strict";
import test from "node:test";
import robots from "../app/robots";
import sitemap from "../app/sitemap";
import { localizedPublicMetadata, publicSiteUrl } from "../app/public/public-seo";
import { fr } from "../app/i18n";

test("localized public metadata provides absolute canonical, hreflang and Open Graph values", () => {
  const metadata = localizedPublicMetadata({
    locale: "fr",
    route: "product",
    options: { query: { item: "geometry" } },
    title: fr.metadata.productTitle.replace("{product}", "Geometry"),
    description: fr.metadata.productDescription.replace("{product}", "Geometry"),
  });

  assert.equal(publicSiteUrl.protocol, "https:");
  assert.notEqual(publicSiteUrl.hostname, "localhost");
  assert.equal(metadata.alternates?.canonical, "https://khaostheoryparis.com/fr/product?item=geometry");
  assert.deepEqual(metadata.alternates?.languages, {
    fr: "https://khaostheoryparis.com/fr/product?item=geometry",
    en: "https://khaostheoryparis.com/en/product?item=geometry",
    "x-default": "https://khaostheoryparis.com/fr/product?item=geometry",
  });
  assert.deepEqual(metadata.openGraph, {
    type: "website",
    title: "Khaos Theory — Geometry",
    description: "Découvrez Geometry, un bijou en argent .925 de Khaos Theory.",
    url: "https://khaostheoryparis.com/fr/product?item=geometry",
    siteName: "Khaos Theory",
    locale: "fr_FR",
    alternateLocale: "en_US",
  });
  assert.deepEqual(metadata.twitter, {
    card: "summary",
    title: "Khaos Theory — Geometry",
    description: "Découvrez Geometry, un bijou en argent .925 de Khaos Theory.",
  });
});

test("technical checkout metadata is explicitly noindex without weakening localized alternates", () => {
  const metadata = localizedPublicMetadata({
    locale: "en",
    route: "checkout",
    title: "Khaos Theory — Your KART",
    description: "Complete your Khaos Theory order securely.",
    indexable: false,
  });

  assert.notEqual(typeof metadata.robots, "string");
  if (!metadata.robots || typeof metadata.robots === "string") throw new Error("Expected structured robots metadata");
  assert.equal(metadata.robots.index, false);
  assert.equal(metadata.robots.follow, false);
  assert.equal(metadata.alternates?.canonical, "https://khaostheoryparis.com/en/checkout");
  assert.equal(metadata.alternates?.languages?.fr, "https://khaostheoryparis.com/fr/checkout");
});

test("robots and sitemap expose only public localized pages", () => {
  const robotsMetadata = robots();
  const rules = Array.isArray(robotsMetadata.rules) ? robotsMetadata.rules[0] : robotsMetadata.rules;
  const sitemapEntries = sitemap();
  const urls = sitemapEntries.map((entry) => entry.url);

  assert.deepEqual(rules?.disallow, ["/admin", "/api/", "/fr/checkout", "/en/checkout", "/fr/success", "/en/success"]);
  assert.equal(robotsMetadata.sitemap, "https://khaostheoryparis.com/sitemap.xml");
  assert.ok(urls.includes("https://khaostheoryparis.com/fr"));
  assert.ok(urls.includes("https://khaostheoryparis.com/en"));
  assert.ok(urls.includes("https://khaostheoryparis.com/fr/product?item=geometry"));
  assert.equal(urls.some((url) => /\/(admin|api)(?:\/|$)|\/(checkout|success)(?:\?|$)/.test(url)), false);
});
