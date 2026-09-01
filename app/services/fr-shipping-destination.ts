import {
  FR_SHIPPING_DESTINATION_SNAPSHOT,
  FR_SHIPPING_DESTINATION_SNAPSHOT_METADATA,
} from "../data/fr-shipping-destinations";

export type FrShippingDestinationInput = {
  country: unknown;
  postalCode: unknown;
  city: unknown;
};

export type FrShippingDestinationRejectionReason =
  | "INVALID_DESTINATION"
  | "INVALID_COUNTRY"
  | "INVALID_POSTAL_CODE"
  | "INVALID_CITY"
  | "UNSUPPORTED_DESTINATION";

export type FrShippingDestinationValidation =
  | {
      eligible: true;
      country: "FR";
      postalCode: string;
      city: string;
    }
  | {
      eligible: false;
      reason: FrShippingDestinationRejectionReason;
    };

const CITY_MAX_LENGTH = 200;
const ALLOWED_DEPARTMENT_PATTERN = /^(?:0[1-9]|1[0-9]|2[1-9]|[3-8][0-9]|9[0-5]|2A|2B)$/u;

const ALLOWED_DESTINATIONS = new Set(
  FR_SHIPPING_DESTINATION_SNAPSHOT.split("\n").map((record) => {
    const [postalCode, city, department, communeCode, unexpected] = record.split("\t");
    if (
      unexpected !== undefined ||
      !/^[0-9]{5}$/u.test(postalCode ?? "") ||
      !city ||
      !ALLOWED_DEPARTMENT_PATTERN.test(department ?? "") ||
      !/^(?:[0-9]{5}|2A[0-9]{3}|2B[0-9]{3})$/u.test(communeCode ?? "")
    ) {
      throw new Error("INVALID_FR_SHIPPING_DESTINATION_SNAPSHOT");
    }
    return destinationKey(postalCode, city);
  }),
);

if (ALLOWED_DESTINATIONS.size !== FR_SHIPPING_DESTINATION_SNAPSHOT_METADATA.entryCount) {
  throw new Error("INVALID_FR_SHIPPING_DESTINATION_SNAPSHOT_COUNT");
}

/**
 * Normalization is deliberately narrow: Unicode compatibility/case/diacritics,
 * typographic apostrophes and hyphens, trim, and repeated whitespace. Punctuation
 * is not removed, so distinct official names are not broadened into arbitrary aliases.
 */
export function normalizeFrShippingCity(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[‘’ʼ`´]/gu, "'")
    .replace(/[‐‑‒–—―−]/gu, "-")
    .trim()
    .replace(/\s+/gu, " ")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLocaleUpperCase("fr-FR");
}

/**
 * Pure allowlist validation for SHIPPING V1: metropolitan France and Corsica.
 * The snapshot excludes DOM/COM/TOM, Monaco and unlisted CEDEX/special codes.
 */
export function validateFrShippingDestination(
  input: unknown,
): FrShippingDestinationValidation {
  if (!isRecord(input)) return { eligible: false, reason: "INVALID_DESTINATION" };

  const country = normalizeCountry(input.country);
  if (country !== "FR") return { eligible: false, reason: "INVALID_COUNTRY" };

  if (typeof input.postalCode !== "string") {
    return { eligible: false, reason: "INVALID_POSTAL_CODE" };
  }
  const postalCode = input.postalCode.trim();
  if (!/^[0-9]{5}$/u.test(postalCode)) {
    return { eligible: false, reason: "INVALID_POSTAL_CODE" };
  }

  if (typeof input.city !== "string" || input.city.length > CITY_MAX_LENGTH) {
    return { eligible: false, reason: "INVALID_CITY" };
  }
  const city = normalizeFrShippingCity(input.city);
  if (!city) return { eligible: false, reason: "INVALID_CITY" };

  if (!ALLOWED_DESTINATIONS.has(destinationKey(postalCode, city))) {
    return { eligible: false, reason: "UNSUPPORTED_DESTINATION" };
  }

  return { eligible: true, country: "FR", postalCode, city };
}

export function isFrShippingDestination(input: unknown): boolean {
  return validateFrShippingDestination(input).eligible;
}

function normalizeCountry(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.normalize("NFKC").trim().toUpperCase();
}

function destinationKey(postalCode: string, city: string) {
  return `${postalCode}\t${city}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
