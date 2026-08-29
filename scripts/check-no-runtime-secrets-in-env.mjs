#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";

const forbiddenRuntimeSecrets = new Set([
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "PENNYLANE_API_TOKEN",
  "CLOUDFLARE_ACCESS_AUD",
]);

const buildEnvFilePattern = /^\.env(?:\.(?:production|development|test))?(?:\.local)?$/;
const definitionPattern = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

export function findForbiddenRuntimeSecrets(rootDirectory) {
  const findings = [];
  const fileNames = readdirSync(rootDirectory)
    .filter((fileName) => buildEnvFilePattern.test(fileName))
    .sort();

  for (const fileName of fileNames) {
    const filePath = `${rootDirectory}/${fileName}`;
    if (!existsSync(filePath)) continue;

    for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
      const match = line.match(definitionPattern);
      const variableName = match?.[1];
      if (variableName && forbiddenRuntimeSecrets.has(variableName)) {
        findings.push({ fileName, variableName });
      }
    }
  }

  return findings;
}

const findings = findForbiddenRuntimeSecrets(process.cwd());

if (findings.length > 0) {
  for (const { fileName, variableName } of findings) {
    console.error(`Forbidden runtime secret ${variableName} found in ${fileName}`);
  }
  process.exitCode = 1;
} else {
  console.log("Runtime secret env guard passed.");
}
