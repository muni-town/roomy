/**
 * Coverage check: every `com.atproto.repo.*` call the client sends with an
 * `atproto-proxy` header must be permitted by the scope the client requests.
 *
 * A proxy header makes the call an RPC to the named audience, so the resource
 * server authorizes it with an `rpc:<nsid>?aud=<did>#<service>` token — not
 * with the `repo:<collection>` grant that covers the same write sent directly.
 * The two are independent, and declaring only the `repo:` half looks correct
 * in review while failing at runtime: the call is refused with a scope-miss on
 * the user's own PDS. That is a shape no type checker or linter catches, so it
 * is checked here instead.
 *
 * The assertion uses the real matcher — `@atproto/oauth-scopes`'s
 * `ScopePermissions`, the same grammar the PDS and HappyView enforce — rather
 * than string-matching the scope list, so a token that parses but does not
 * authorize the call still fails.
 *
 * The sources scanned span both packages: the proxied calls live in the SDK
 * (`sdk/src/atproto`, `sdk/src/client`) and in app-lite (the profile-save
 * route). app-lite holds the scope and the test runner, so the check lives
 * here and reaches into the SDK by path.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ScopePermissions } from "@atproto/oauth-scopes";
import { SCOPE_SETS } from "./scopes.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** Directories to scan, relative to the repo root. */
const SCAN_ROOTS = [
  "packages/sdk/src/atproto",
  "packages/sdk/src/client",
  "packages/app-lite/src",
];

/**
 * Calls the scan must find. Pins the set so a refactor that defeats the scan
 * (which would otherwise let the coverage assertion pass vacuously) fails
 * loudly instead. Adding a proxied call does not require editing this list —
 * only losing the ability to see the existing ones does.
 */
const KNOWN_PROXIED_CALLS = [
  "com.atproto.repo.putRecord",
  "com.atproto.repo.deleteRecord",
  "com.atproto.repo.uploadBlob",
  "com.atproto.repo.getRecord",
];

const PROXIED_CALL_RE = /com\.atproto\.repo\.([A-Za-z][A-Za-z0-9]*)\s*\(/g;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|svelte)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

/**
 * The `com.atproto.repo.*` method a given `atproto-proxy` occurrence belongs
 * to: the nearest preceding call in the same statement.
 *
 * A heuristic — "nearest preceding, with no `;` between" — because deciding
 * it properly means parsing the call's argument list, and the alternative
 * (treat every proxied repo call as unknown) would either miss a real gap or
 * force a hand-maintained list, which is the drift being guarded against.
 * `KNOWN_PROXIED_CALLS` is what makes a misread visible.
 */
function methodForProxyAt(src: string, proxyIndex: number): string | null {
  let found: string | null = null;
  PROXIED_CALL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PROXIED_CALL_RE.exec(src)) !== null) {
    if (match.index > proxyIndex) break;
    if (src.slice(match.index + match[0].length, proxyIndex).includes(";")) continue;
    found = `com.atproto.repo.${match[1]}`;
  }
  return found;
}

/** Every proxied `com.atproto.repo.*` call in the scanned sources. */
function findProxiedRepoCalls(): Record<string, string[]> {
  const calls: Record<string, string[]> = {};
  for (const root of SCAN_ROOTS) {
    for (const file of sourceFiles(join(repoRoot, root))) {
      const src = readFileSync(file, "utf-8");
      let index = -1;
      while ((index = src.indexOf("atproto-proxy", index + 1)) !== -1) {
        const method = methodForProxyAt(src, index);
        if (!method) continue;
        const line = src.slice(0, index).split("\n").length;
        const where = `${relative(repoRoot, file)}:${line}`;
        (calls[method] ??= []).push(where);
      }
    }
  }
  return calls;
}

describe("proxied com.atproto.repo.* calls are covered by the requested scope", () => {
  // A concrete DID stands in for the audience, which is per-user (the caller's
  // own PDS, or a space's). The scope must therefore authorize any DID's
  // `#atproto_pds`, i.e. carry `aud=*` — a pinned DID would not match.
  const aud = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa#atproto_pds";
  const granted = new ScopePermissions(SCOPE_SETS.base);

  test("the scan finds the known proxied calls", () => {
    const found = Object.keys(findProxiedRepoCalls());
    for (const expected of KNOWN_PROXIED_CALLS) {
      assert.ok(
        found.includes(expected),
        `scan did not find ${expected}; it found: ${found.sort().join(", ")}`,
      );
    }
  });

  test("the base tier authorizes every proxied call it sends", () => {
    const missing = Object.entries(findProxiedRepoCalls())
      .filter(([lxm]) => !granted.allowsRpc({ lxm, aud }))
      .map(([lxm, sites]) => `${lxm} (needed by ${sites.join(", ")})`);

    assert.deepEqual(
      missing,
      [],
      `scope is missing rpc:<nsid>?aud=* for:\n  ${missing.join("\n  ")}`,
    );
  });
});
