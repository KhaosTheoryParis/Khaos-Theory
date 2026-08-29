import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import test from "node:test";

const guardScript = resolve("scripts/check-no-runtime-secrets-in-env.mjs");

function withFixture(files: Record<string, string>, assertion: (result: SpawnSyncReturns<string>) => void) {
  const directory = mkdtempSync(`${tmpdir()}/khaos-runtime-secret-guard-`);

  try {
    for (const [fileName, contents] of Object.entries(files)) {
      writeFileSync(`${directory}/${fileName}`, contents);
    }

    assertion(spawnSync(process.execPath, [guardScript], { cwd: directory, encoding: "utf8" }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("runtime secrets are permitted in .dev.vars but not loaded as build env", () => {
  withFixture(
    {
      ".dev.vars": "STRIPE_SECRET_KEY=runtime_canary_not_a_secret\n",
      ".env.local": "SITE_URL=https://example.test\n",
    },
    (result) => {
      assert.equal(result.status, 0);
      assert.match(result.stdout, /Runtime secret env guard passed/);
    },
  );
});

test("the guard rejects forbidden runtime secret names without printing their values", () => {
  const canary = "must_never_appear_in_guard_output";

  withFixture({ ".env.local": `STRIPE_SECRET_KEY=${canary}\n` }, (result) => {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Forbidden runtime secret STRIPE_SECRET_KEY found in \.env\.local/);
    assert.equal(result.stderr.includes(canary), false);
    assert.equal(result.stdout.includes(canary), false);
  });
});

test("the guard covers every runtime secret and every OpenNext production env file", () => {
  withFixture(
    {
      ".env": "PENNYLANE_API_TOKEN=not_real\n",
      ".env.production": "CLOUDFLARE_ACCESS_AUD=not_real\n",
      ".env.production.local": "STRIPE_WEBHOOK_SECRET=not_real\n",
    },
    (result) => {
      assert.equal(result.status, 1);
      assert.match(result.stderr, /PENNYLANE_API_TOKEN found in \.env/);
      assert.match(result.stderr, /CLOUDFLARE_ACCESS_AUD found in \.env\.production/);
      assert.match(result.stderr, /STRIPE_WEBHOOK_SECRET found in \.env\.production\.local/);
      assert.equal(result.stderr.includes("not_real"), false);
    },
  );
});
