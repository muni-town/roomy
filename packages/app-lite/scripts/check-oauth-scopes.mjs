#!/usr/bin/env node
/**
 * OAuth scope drift check (CI-runnable).
 *
 * Verifies:
 *   1. Every tier's scopes (src/lib/scopes.ts SCOPE_SETS) are a subset of the
 *      metadata ceiling (FULL_SCOPE_CEILING) — so any scope a tier requests is
 *      always declared in the OAuth metadata the PDS enforces against.
 *   2. scripts/build-prod.sh still derives its SCOPE assembly from
 *      FULL_SCOPE_CEILING (its single source of truth), so what ships can't
 *      drift from the ceiling.
 *
 * Before the client-scope refactor this compared a hand-maintained SCOPE
 * assembly against config.ts; scopes.ts is now the single source of truth and
 * build-prod.sh imports the ceiling directly.
 *
 * Run: node --experimental-strip-types scripts/check-oauth-scopes.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCOPE_SETS, FULL_SCOPE_CEILING, parseScopes } from "../src/lib/scopes.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const buildScript = readFileSync(join(root, "scripts/build-prod.sh"), "utf-8");

let hasErrors = false;

// Every tier scope must be declared in the ceiling.
const ceilingScopes = parseScopes(FULL_SCOPE_CEILING);
for (const [tier, tierScope] of Object.entries(SCOPE_SETS)) {
  for (const s of parseScopes(tierScope)) {
    if (!ceilingScopes.has(s)) {
      console.log(`MISSING SCOPE (tier ${tier} not in ceiling): ${s}`);
      hasErrors = true;
    }
  }
}

// build-prod.sh must derive its SCOPE from FULL_SCOPE_CEILING — importing the
// constant, not re-assembling a scope string by hand. This is the mechanism
// that keeps whatever ships byte-identical to the single source of truth.
if (
  !buildScript.includes("FULL_SCOPE_CEILING") ||
  !buildScript.includes("import('./src/lib/scopes.ts')")
) {
  console.log("MISMATCH: build-prod.sh no longer derives SCOPE from FULL_SCOPE_CEILING");
  hasErrors = true;
}

if (hasErrors) {
  console.error(
    "ERROR: A tier scope is missing from the ceiling, or build-prod.sh no longer",
  );
  console.error("derives its SCOPE from src/lib/scopes.ts FULL_SCOPE_CEILING.");
  console.error("Fix the tier/ceiling definitions in src/lib/scopes.ts.");
  process.exit(1);
}

console.log("All tier scopes present in ceiling, build-prod derives SCOPE from ceiling — verification passed");
