import assert from "node:assert/strict";
import test from "node:test";
import {
  FR_SHIPPING_DESTINATION_SNAPSHOT,
  FR_SHIPPING_DESTINATION_SNAPSHOT_METADATA,
} from "../app/data/fr-shipping-destinations";
import {
  isFrShippingDestination,
  normalizeFrShippingCity,
  validateFrShippingDestination,
} from "../app/services/fr-shipping-destination";

function destination(postalCode: unknown, city: unknown, country: unknown = "FR") {
  return { country, postalCode, city };
}

test("official snapshot accepts metropolitan France and both Corsican departments", () => {
  assert.equal(isFrShippingDestination(destination("75001", "Paris")), true);
  assert.equal(isFrShippingDestination(destination("01000", "Bourg en Bresse")), true);
  assert.equal(isFrShippingDestination(destination("20000", "Ajaccio")), true);
  assert.equal(isFrShippingDestination(destination("20200", "Bastia")), true);
});

test("official snapshot rejects DOM, COM/TOM and Monaco destinations", () => {
  for (const [postalCode, city] of [
    ["97100", "Basse-Terre"],
    ["97200", "Fort-de-France"],
    ["97300", "Cayenne"],
    ["97400", "Saint-Denis"],
    ["97600", "Mamoudzou"],
    ["98714", "Papeete"],
    ["98800", "Nouméa"],
    ["97500", "Saint-Pierre"],
    ["98000", "Monaco"],
  ]) {
    assert.deepEqual(validateFrShippingDestination(destination(postalCode, city)), {
      eligible: false,
      reason: "UNSUPPORTED_DESTINATION",
    });
  }
});

test("country must normalize to the exact ISO country FR", () => {
  assert.equal(isFrShippingDestination(destination("75001", "Paris", " fr ")), true);
  for (const country of ["DE", "FRA", "France", "", null, 1]) {
    assert.deepEqual(validateFrShippingDestination(destination("75001", "Paris", country)), {
      eligible: false,
      reason: "INVALID_COUNTRY",
    });
  }
});

test("postal codes remain strict five-character ASCII strings with leading zeroes", () => {
  assert.equal(isFrShippingDestination(destination("01000", "Bourg en Bresse")), true);
  for (const postalCode of ["1000", "001000", "01A00", "０１０００", 1000, null]) {
    assert.deepEqual(validateFrShippingDestination(destination(postalCode, "Bourg en Bresse")), {
      eligible: false,
      reason: "INVALID_POSTAL_CODE",
    });
  }
  assert.deepEqual(validateFrShippingDestination(destination("00000", "Paris")), {
    eligible: false,
    reason: "UNSUPPORTED_DESTINATION",
  });
});

test("city matching handles case, accents, Unicode punctuation and repeated spaces narrowly", () => {
  assert.equal(isFrShippingDestination(destination("45000", "orléans")), true);
  assert.equal(isFrShippingDestination(destination("01000", "  bourg   en   bresse  ")), true);
  assert.equal(isFrShippingDestination(destination("94240", "L’Haÿ-les-Roses")), true);
  assert.equal(normalizeFrShippingCity(" L’Haÿ‑les‑Roses "), "L'HAY-LES-ROSES");
  assert.deepEqual(validateFrShippingDestination(destination("75001", "Lyon")), {
    eligible: false,
    reason: "UNSUPPORTED_DESTINATION",
  });
});

test("snapshot preserves shared postal codes and communes with multiple postal codes", () => {
  assert.equal(isFrShippingDestination(destination("54490", "Avillers")), true);
  assert.equal(isFrShippingDestination(destination("54490", "Piennes")), true);
  assert.equal(isFrShippingDestination(destination("57000", "Metz")), true);
  assert.equal(isFrShippingDestination(destination("57050", "Metz")), true);
  assert.equal(isFrShippingDestination(destination("57070", "Metz")), true);
  assert.ok(FR_SHIPPING_DESTINATION_SNAPSHOT_METADATA.postalCodesWithMultipleCommunes > 0);
  assert.ok(FR_SHIPPING_DESTINATION_SNAPSHOT_METADATA.communesWithMultiplePostalCodes > 0);
});

test("invalid destination shapes and unlisted city aliases fail closed", () => {
  for (const input of [null, [], "Paris", 1]) {
    assert.deepEqual(validateFrShippingDestination(input), {
      eligible: false,
      reason: "INVALID_DESTINATION",
    });
  }
  assert.deepEqual(validateFrShippingDestination(destination("75001", "")), {
    eligible: false,
    reason: "INVALID_CITY",
  });
  assert.equal(isFrShippingDestination(destination("94240", "LHAYLESROSES")), false);
});

test("every embedded snapshot record is structurally metropolitan or Corsican", () => {
  const records = FR_SHIPPING_DESTINATION_SNAPSHOT.split("\n");
  assert.equal(records.length, FR_SHIPPING_DESTINATION_SNAPSHOT_METADATA.entryCount);
  assert.ok(records.length > 30_000);

  for (const record of records) {
    const [postalCode, city, department, communeCode, unexpected] = record.split("\t");
    assert.equal(unexpected, undefined);
    assert.match(postalCode, /^[0-9]{5}$/u);
    assert.ok(city.length > 0);
    assert.match(department, /^(?:0[1-9]|1[0-9]|2[1-9]|[3-8][0-9]|9[0-5]|2A|2B)$/u);
    assert.match(communeCode, /^(?:[0-9]{5}|2A[0-9]{3}|2B[0-9]{3})$/u);
    assert.doesNotMatch(department, /^(?:97|98)/u);
    assert.notEqual(communeCode, "99138");
  }

  assert.deepEqual(FR_SHIPPING_DESTINATION_SNAPSHOT_METADATA.exclusions, [
    "DOM",
    "COM",
    "TOM",
    "MONACO",
    "UNLISTED_SPECIAL_CODES",
  ]);
  assert.equal(FR_SHIPPING_DESTINATION_SNAPSHOT_METADATA.sourceRowsMissingFromCog >= 0, true);
});
