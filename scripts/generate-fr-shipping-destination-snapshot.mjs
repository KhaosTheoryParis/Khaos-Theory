#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const [postalCsvPath, cogCsvPath, outputPath] = process.argv.slice(2);

if (!postalCsvPath || !cogCsvPath || !outputPath) {
  console.error(
    "Usage: node scripts/generate-fr-shipping-destination-snapshot.mjs <LaPoste.csv> <INSEE-COG.csv> <output.ts>",
  );
  process.exit(1);
}

const LA_POSTE_SOURCE = {
  dataset: "Base officielle des codes postaux",
  datasetId: "laposte-hexasmal",
  url: "https://data.laposte.fr/data-fair/api/v1/datasets/laposte-hexasmal/",
  dataUpdatedAt: "2026-08-08T02:02:09.846Z",
  originalFile: "019HexaSmal.csv",
  originalFileMd5: "0d4c9510efab94b153dbba939be6b9f1",
};

const INSEE_SOURCE = {
  dataset: "Code officiel géographique au 1er janvier 2026 - Communes",
  url: "https://www.insee.fr/fr/statistiques/fichier/8740222/v_commune_2026.csv",
  vintage: "2026-01-01",
  pageUpdatedAt: "2026-02-24",
};

const SNAPSHOT_GENERATED_AT = "2026-08-30";
const NORMALIZATION_VERSION = 1;

function parseCsv(text, delimiter) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === delimiter) {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/u, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }

  if (quoted) throw new Error("UNTERMINATED_CSV_QUOTE");
  if (field || row.length > 0) {
    row.push(field.replace(/\r$/u, ""));
    rows.push(row);
  }

  const [header, ...dataRows] = rows;
  return dataRows
    .filter((values) => values.some(Boolean))
    .map((values) => Object.fromEntries(header.map((column, index) => [column, values[index] ?? ""])));
}

function normalizeCity(value) {
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

function isMetropolitanDepartment(department) {
  if (department === "2A" || department === "2B") return true;
  if (!/^[0-9]{2}$/u.test(department)) return false;
  const numericDepartment = Number(department);
  return numericDepartment >= 1 && numericDepartment <= 95 && numericDepartment !== 20;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

const postalBuffer = readFileSync(postalCsvPath);
const cogBuffer = readFileSync(cogCsvPath);
const postalRows = parseCsv(new TextDecoder("windows-1252").decode(postalBuffer), ";");
const cogRows = parseCsv(new TextDecoder("utf-8").decode(cogBuffer), ",");

const cogByCommune = new Map();
for (const row of cogRows) {
  const communeCode = row.COM;
  const department = row.DEP;
  if (!communeCode || !department) continue;

  const existing = cogByCommune.get(communeCode) ?? {
    department,
    aliases: new Set(),
  };
  if (existing.department !== department) {
    throw new Error(`INCONSISTENT_COG_DEPARTMENT:${communeCode}`);
  }
  for (const alias of [row.NCC, row.NCCENR, row.LIBELLE]) {
    if (alias) existing.aliases.add(alias);
  }
  cogByCommune.set(communeCode, existing);
}

const entriesByDestination = new Map();
const communePostalCodes = new Map();
const postalCommuneCodes = new Map();
let includedSourceRows = 0;
let excludedSourceRows = 0;
let missingCogRows = 0;
let normalizationCollisions = 0;
const normalizationCollisionSamples = new Set();

for (const row of postalRows) {
  const communeCode = row["#Code_commune_INSEE"];
  const postalCode = row.Code_postal;
  const cogCommune = cogByCommune.get(communeCode);

  if (!cogCommune) {
    missingCogRows += 1;
    continue;
  }
  if (!isMetropolitanDepartment(cogCommune.department)) {
    excludedSourceRows += 1;
    continue;
  }
  if (!/^[0-9]{5}$/u.test(postalCode)) {
    throw new Error(`INVALID_ALLOWED_POSTAL_CODE:${communeCode}`);
  }

  includedSourceRows += 1;
  const aliases = new Set([
    row.Nom_de_la_commune,
    row["Libellé_d_acheminement"],
    row.Ligne_5,
    ...cogCommune.aliases,
  ]);

  for (const rawAlias of aliases) {
    if (!rawAlias) continue;
    const city = normalizeCity(rawAlias);
    if (!city) continue;
    const destinationKey = `${postalCode}\t${city}`;
    const existing = entriesByDestination.get(destinationKey);
    if (existing && existing.communeCode !== communeCode) {
      normalizationCollisions += 1;
      normalizationCollisionSamples.add(
        `${destinationKey}\t${existing.communeCode}\t${communeCode}`,
      );
    }
    if (!existing) {
      entriesByDestination.set(destinationKey, {
        postalCode,
        city,
        department: cogCommune.department,
        communeCode,
      });
    }
  }

  const postalCodes = communePostalCodes.get(communeCode) ?? new Set();
  postalCodes.add(postalCode);
  communePostalCodes.set(communeCode, postalCodes);

  const communeCodes = postalCommuneCodes.get(postalCode) ?? new Set();
  communeCodes.add(communeCode);
  postalCommuneCodes.set(postalCode, communeCodes);
}

const entries = [...entriesByDestination.values()].sort(
  (left, right) =>
    left.postalCode.localeCompare(right.postalCode) ||
    left.city.localeCompare(right.city, "fr") ||
    left.communeCode.localeCompare(right.communeCode),
);
const encodedSnapshot = entries
  .map(({ postalCode, city, department, communeCode }) =>
    [postalCode, city, department, communeCode].join("\t"),
  )
  .join("\n");

const metadata = {
  laPoste: {
    ...LA_POSTE_SOURCE,
    sha256: sha256(postalBuffer),
  },
  insee: {
    ...INSEE_SOURCE,
    sha256: sha256(cogBuffer),
  },
  generatedAt: SNAPSHOT_GENERATED_AT,
  generator: "scripts/generate-fr-shipping-destination-snapshot.mjs",
  normalizationVersion: NORMALIZATION_VERSION,
  sourceRowCount: postalRows.length,
  includedSourceRowCount: includedSourceRows,
  excludedSourceRowCount: excludedSourceRows,
  sourceRowsMissingFromCog: missingCogRows,
  entryCount: entries.length,
  postalCodeCount: new Set(entries.map((entry) => entry.postalCode)).size,
  communeCodeCount: new Set(entries.map((entry) => entry.communeCode)).size,
  postalCodesWithMultipleCommunes: [...postalCommuneCodes.values()].filter(
    (communeCodes) => communeCodes.size > 1,
  ).length,
  communesWithMultiplePostalCodes: [...communePostalCodes.values()].filter(
    (postalCodes) => postalCodes.size > 1,
  ).length,
  normalizedTupleCollisionsAcrossCommunes: normalizationCollisions,
  normalizedTupleCollisionSamples: [...normalizationCollisionSamples].sort().slice(0, 10),
  allowedDepartments: ["01-19", "21-95", "2A", "2B"],
  exclusions: ["DOM", "COM", "TOM", "MONACO", "UNLISTED_SPECIAL_CODES"],
};

const output = `/**
 * Generated official snapshot. Do not edit manually.
 *
 * Runtime records are: postalCode\\tNFKC/NFD-normalized city\\tCOG department\\tINSEE commune.
 * The generator positively joins La Poste postal rows to INSEE COG 2026 communes and retains
 * only departments 01-19, 21-95, 2A and 2B. Overseas territories and Monaco are therefore
 * excluded by construction rather than by a postal-prefix denylist.
 */
export const FR_SHIPPING_DESTINATION_SNAPSHOT_METADATA = ${JSON.stringify(metadata, null, 2)} as const;

export const FR_SHIPPING_DESTINATION_SNAPSHOT = ${JSON.stringify(encodedSnapshot)};
`;

writeFileSync(outputPath, output, "utf8");
console.log(
  JSON.stringify({
    outputPath,
    entryCount: metadata.entryCount,
    postalCodeCount: metadata.postalCodeCount,
    communeCodeCount: metadata.communeCodeCount,
    postalCodesWithMultipleCommunes: metadata.postalCodesWithMultipleCommunes,
    communesWithMultiplePostalCodes: metadata.communesWithMultiplePostalCodes,
    normalizedTupleCollisionsAcrossCommunes: metadata.normalizedTupleCollisionsAcrossCommunes,
    sourceRowsMissingFromCog: metadata.sourceRowsMissingFromCog,
  }),
);
