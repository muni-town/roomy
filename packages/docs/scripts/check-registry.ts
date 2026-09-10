/**
 * CI check — the endpoint catalogue must match the appserver router.
 *
 * 1. Regenerates `nsids.generated.json` from the router and fails if the
 *    committed file is stale (drift).
 * 2. Fails if any registered NSID lacks prose in `src/lib/endpoints/prose.ts`
 *    (incompleteness).
 *
 * Run: `pnpm --filter docs check:registry`
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRouter } from "./generate-registry.ts";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(THIS_DIR, "..", "..", "..");
const ROUTER_PATH = join(REPO_ROOT, "packages", "appserver", "src", "appserver.ts");
const GENERATED_PATH = join(THIS_DIR, "..", "src", "lib", "endpoints", "nsids.generated.json");
const PROSE_PATH = join(THIS_DIR, "..", "src", "lib", "endpoints", "prose.ts");

let failed = false;

// 1. Staleness check: regenerate and compare with the committed snapshot.
const source = readFileSync(ROUTER_PATH, "utf8");
const fresh = parseRouter(source);
const committed = JSON.parse(readFileSync(GENERATED_PATH, "utf8")) as unknown[];
const freshJson = JSON.stringify(fresh, null, 2) + "\n";
const committedJson = JSON.stringify(committed, null, 2) + "\n";

if (freshJson !== committedJson) {
  failed = true;
  console.error(
    "✗ nsids.generated.json is stale. Run `pnpm --filter docs generate:registry` and commit the result.",
  );
  writeFileSync(GENERATED_PATH, freshJson);
} else {
  console.log(`✔ Catalogue skeleton matches the router (${fresh.length} NSIDs).`);
}

// 2. Completeness check: every registered NSID must have prose.
const proseSource = readFileSync(PROSE_PATH, "utf8");
const missing = fresh.filter((e) => !proseSource.includes(`"${e.nsid}":`));
if (missing.length > 0) {
  failed = true;
  console.error(`✗ ${missing.length} registered NSID(s) missing prose in prose.ts:`);
  for (const m of missing) console.error(`  - ${m.nsid}`);
} else {
  console.log("✔ Every registered NSID has prose.");
}

if (failed) process.exit(1);
