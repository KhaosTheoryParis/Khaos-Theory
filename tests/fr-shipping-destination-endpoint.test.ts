import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { POST } from "../app/api/shipping/validate-destination/route";

const ENDPOINT_URL = "https://example.test/api/shipping/validate-destination";

function request(body: unknown) {
  return new Request(ENDPOINT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function rawRequest(body: string, contentType: string) {
  return new Request(ENDPOINT_URL, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body,
  });
}

async function responseBody(response: Response) {
  return (await response.json()) as unknown;
}

test("the public endpoint accepts metropolitan France and Corsica", async () => {
  for (const destination of [
    { country: "FR", postalCode: "75001", city: "Paris" },
    { country: "FR", postalCode: "20000", city: "Ajaccio" },
    { country: "FR", postalCode: "20200", city: "Bastia" },
  ]) {
    const response = await POST(request(destination));
    assert.equal(response.status, 200);
    assert.deepEqual(await responseBody(response), { eligible: true });
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});

test("the endpoint rejects overseas, Monaco and unknown destinations without details", async () => {
  for (const destination of [
    { country: "FR", postalCode: "97100", city: "Basse-Terre" },
    { country: "FR", postalCode: "97400", city: "Saint-Denis" },
    { country: "FR", postalCode: "98000", city: "Monaco" },
    { country: "FR", postalCode: "00000", city: "Ville inconnue" },
    { country: "FR", postalCode: "75001", city: "Lyon" },
  ]) {
    const response = await POST(request(destination));
    assert.equal(response.status, 422);
    assert.deepEqual(await responseBody(response), { eligible: false });
  }
});

test("null, arrays and scalar JSON bodies are rejected as strict unknown input", async () => {
  for (const body of [null, [], "value", 1]) {
    const response = await POST(request(body));
    assert.equal(response.status, 400);
    assert.deepEqual(await responseBody(response), { eligible: false });
  }
});

test("missing fields, wrong types and unexpected properties are rejected", async () => {
  for (const body of [
    { country: "FR", postalCode: "75001" },
    { country: "FR", postalCode: 75001, city: "Paris" },
    { country: "FR", postalCode: "75001", city: null },
    { country: "FR", postalCode: "75001", city: "Paris", line1: "1 rue Exemple" },
  ]) {
    const response = await POST(request(body));
    assert.equal(response.status, 400);
    assert.deepEqual(await responseBody(response), { eligible: false });
  }
});

test("a client eligible flag cannot grant eligibility", async () => {
  const forgedEligible = await POST(
    request({
      country: "FR",
      postalCode: "97100",
      city: "Basse-Terre",
      eligible: true,
    }),
  );
  assert.equal(forgedEligible.status, 400);
  assert.deepEqual(await responseBody(forgedEligible), { eligible: false });
});

test("the endpoint enforces JSON and a small bounded request body", async () => {
  const wrongMediaType = await POST(rawRequest("plain text", "text/plain"));
  assert.equal(wrongMediaType.status, 415);
  assert.deepEqual(await responseBody(wrongMediaType), { eligible: false });

  const oversized = await POST(
    request({ country: "FR", postalCode: "75001", city: "P".repeat(2_100) }),
  );
  assert.equal(oversized.status, 413);
  assert.deepEqual(await responseBody(oversized), { eligible: false });
});

test("validation is deterministic and the route contains no network or external service access", async () => {
  const destination = { country: "FR", postalCode: "75001", city: "Paris" };
  const first = await POST(request(destination));
  const second = await POST(request(destination));
  assert.equal(first.status, second.status);
  assert.deepEqual(await responseBody(first), await responseBody(second));

  const source = readFileSync("app/api/shipping/validate-destination/route.ts", "utf8");
  assert.match(source, /validateFrShippingDestination\(body\)/);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /getCloudflareContext|STRIPE|PENNYLANE|\bDB\b|verifyCloudflareAccess/);
  assert.doesNotMatch(source, /FR_SHIPPING_DESTINATION_SNAPSHOT/);
});
