import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { POST } from "../app/api/shipping/quote/route";
import { FREE_SHIPPING_THRESHOLD, FR_SHIPPING_AMOUNT } from "../app/services/shipping";

const ENDPOINT_URL = "https://example.test/api/shipping/quote";

function request(body: unknown) {
  return new Request(ENDPOINT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function responseBody(response: Response) {
  return (await response.json()) as unknown;
}

function destination(productsSubtotal: unknown, postalCode = "75001", city = "Paris") {
  return { country: "FR", postalCode, city, productsSubtotal };
}

test("Paris below the threshold receives the fixed France shipping quote", async () => {
  const response = await POST(request(destination(39_999)));
  assert.equal(response.status, 200);
  assert.deepEqual(await responseBody(response), {
    eligible: true,
    currency: "eur",
    productsSubtotal: 39_999,
    shippingAmount: 1_000,
    totalAmount: 40_999,
    shippingCountry: "FR",
    shippingZone: "FR",
  });
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("Paris at the threshold receives free shipping", async () => {
  const response = await POST(request(destination(40_000)));
  assert.equal(response.status, 200);
  assert.deepEqual(await responseBody(response), {
    eligible: true,
    currency: "eur",
    productsSubtotal: 40_000,
    shippingAmount: 0,
    totalAmount: 40_000,
    shippingCountry: "FR",
    shippingZone: "FR",
  });
});

test("Corsica receives paid shipping below and free shipping at the threshold", async () => {
  const paid = await POST(request(destination(25_000, "20000", "Ajaccio")));
  assert.equal(paid.status, 200);
  assert.deepEqual(await responseBody(paid), {
    eligible: true,
    currency: "eur",
    productsSubtotal: 25_000,
    shippingAmount: 1_000,
    totalAmount: 26_000,
    shippingCountry: "FR",
    shippingZone: "FR",
  });

  const free = await POST(request(destination(40_000, "20200", "Bastia")));
  assert.equal(free.status, 200);
  assert.deepEqual(await responseBody(free), {
    eligible: true,
    currency: "eur",
    productsSubtotal: 40_000,
    shippingAmount: 0,
    totalAmount: 40_000,
    shippingCountry: "FR",
    shippingZone: "FR",
  });
});

test("DOM, Monaco and an incompatible postal city pair receive no quote", async () => {
  for (const body of [
    destination(25_000, "97100", "Basse-Terre"),
    destination(25_000, "98000", "Monaco"),
    destination(25_000, "75001", "Lyon"),
  ]) {
    const response = await POST(request(body));
    assert.equal(response.status, 422);
    assert.deepEqual(await responseBody(response), { eligible: false });
  }
});

test("negative, fractional and unsafe subtotals are rejected before quoting", async () => {
  for (const productsSubtotal of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const response = await POST(request(destination(productsSubtotal)));
    assert.equal(response.status, 400);
    assert.deepEqual(await responseBody(response), { eligible: false });
  }
});

test("strict unknown body validation rejects scalars, missing fields and extra properties", async () => {
  for (const body of [
    null,
    [],
    "value",
    1,
    { country: "FR", postalCode: "75001", city: "Paris" },
    { country: "FR", postalCode: "75001", city: "Paris", productsSubtotal: "39999" },
    { ...destination(39_999), eligible: true },
  ]) {
    const response = await POST(request(body));
    assert.equal(response.status, 400);
    assert.deepEqual(await responseBody(response), { eligible: false });
  }
});

test("the quote endpoint requires JSON and bounds the request body", async () => {
  const wrongMediaType = await POST(
    new Request(ENDPOINT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "not json",
    }),
  );
  assert.equal(wrongMediaType.status, 415);
  assert.deepEqual(await responseBody(wrongMediaType), { eligible: false });

  const oversized = await POST(
    request(destination(39_999, "75001", "P".repeat(2_100))),
  );
  assert.equal(oversized.status, 413);
  assert.deepEqual(await responseBody(oversized), { eligible: false });
});

test("the endpoint reuses shipping.ts and is explicitly non-authoritative for payment", () => {
  assert.equal(FREE_SHIPPING_THRESHOLD, 40_000);
  assert.equal(FR_SHIPPING_AMOUNT, 1_000);

  const source = readFileSync("app/api/shipping/quote/route.ts", "utf8");
  assert.match(source, /import \{ quoteShipping \} from "\.\.\/\.\.\/\.\.\/services\/shipping"/);
  assert.match(source, /quoteShipping\(body\.productsSubtotal, "fr"\)/);
  assert.match(source, /never payment authority/);
  assert.match(source, /server-side catalog/);
  assert.doesNotMatch(source, /\b40_?000\b|\b1_?000\b/);
  assert.doesNotMatch(source, /\bfetch\s*\(|getCloudflareContext|STRIPE|PENNYLANE|\bDB\b/);
});
