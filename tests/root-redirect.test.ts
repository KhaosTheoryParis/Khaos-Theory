import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { buildLocalizedRootRedirect } from "../app/(default)/page";

test("the server root redirects permanently to the French canonical home", () => {
  assert.equal(buildLocalizedRootRedirect(), "/fr");
  assert.equal(buildLocalizedRootRedirect({ utm_source: "xxx", campaign: "summer sale" }), "/fr?utm_source=xxx&campaign=summer+sale");
  assert.equal(buildLocalizedRootRedirect({ tag: ["one", "two"] }), "/fr?tag=one&tag=two");
});

test("the root redirect does not create a client-side homepage or affect localized routes", () => {
  const source = readFileSync("app/(default)/page.tsx", "utf8");
  assert.equal(existsSync("public/index.html"), false);
  assert.match(source, /permanentRedirect\(/);
  assert.doesNotMatch(source, /useEffect|window\.location|\/index\.html/);
  assert.match(source, /return serializedQuery \? `\/fr\?\$\{serializedQuery\}` : "\/fr"/);
});
