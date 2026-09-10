/**
 * Registry generator — derives the authoritative endpoint list from the
 * appserver's router registration.
 *
 * The appserver's `buildRouter()` in `packages/appserver/src/appserver.ts`
 * is the single source of truth for which XRPC methods exist. This script
 * parses the `.query(...)` / `.procedure(...)` / `.sync(...)` registrations
 * and emits `src/lib/endpoints/nsids.generated.json` — the skeleton the
 * docs catalogue is built from.
 *
 * Hand-written prose (descriptions, schemas, notes) lives in
 * `src/lib/endpoints/prose.ts`, keyed by NSID. The catalogue in
 * `registry.ts` merges the two.
 *
 * Run: `pnpm --filter docs generate:registry`
 * CI:  `pnpm --filter docs check:registry` (fails on drift)
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(THIS_DIR, "..", "..", "..");
const ROUTER_PATH = join(REPO_ROOT, "packages", "appserver", "src", "appserver.ts");
const OUT_PATH = join(THIS_DIR, "..", "src", "lib", "endpoints", "nsids.generated.json");

/** Map a `space.roomy.<category>.<method>` NSID to a docs group name. */
const GROUP_BY_CATEGORY: Record<string, string> = {
  auth: "Auth",
  space: "Spaces",
  room: "Rooms",
  message: "Messages",
  user: "Users",
  sync: "Sync",
  push: "Push Notifications",
  getFlags: "Feature Flags",
  admin: "Admin",
  federation: "Federation",
  mention: "Mentions",
  search: "Search",
  embed: "Embeds",
};

export interface GeneratedNsid {
  nsid: string;
  kind: "query" | "procedure" | "sync";
  group: string;
}

export function parseRouter(source: string): GeneratedNsid[] {
  const out: GeneratedNsid[] = [];
  const re = /\.(query|procedure|sync)\("(space\.roomy\.[a-zA-Z.]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const kind = m[1] as GeneratedNsid["kind"];
    const nsid = m[2];
    const category = nsid.split(".")[2] ?? "";
    out.push({
      nsid,
      kind,
      group: GROUP_BY_CATEGORY[category] ?? "Other",
    });
  }
  // Dedupe + stable sort (router order is already stable, but be safe).
  const seen = new Set<string>();
  return out.filter((e) => (seen.has(e.nsid) ? false : (seen.add(e.nsid), true)));
}

export function generate(): GeneratedNsid[] {
  const source = readFileSync(ROUTER_PATH, "utf8");
  const nsids = parseRouter(source);
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(nsids, null, 2) + "\n");
  return nsids;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const nsids = generate();
  console.log(`Wrote ${nsids.length} NSIDs to ${OUT_PATH}`);
}
