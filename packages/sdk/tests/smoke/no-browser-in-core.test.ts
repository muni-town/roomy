/**
 * Build-time smoke test: the core SDK entry (`@roomy-space/sdk`) must NOT
 * pull in `@atproto/oauth-client-browser` or `svelte` — those dependencies
 * are isolated behind the `/browser` and `/svelte` subpath exports respectively.
 *
 * This test imports the **built** `dist/index.js` (not `src/index.ts`) so
 * it reflects what downstream consumers actually resolve.  It checks the
 * resolved module tree for any reference to the forbidden packages.
 *
 * Run via:  pnpm vitest run tests/smoke/no-browser-in-core.test.ts
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(__dirname, "../../dist");

function walkJsFiles(dir: string): string[] {
  const entries: string[] = [];
  try {
    for (const entry of require("node:fs").readdirSync(dir, {
      withFileTypes: true,
    })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        entries.push(...walkJsFiles(full));
      } else if (entry.name.endsWith(".js")) {
        entries.push(full);
      }
    }
  } catch {
    // directory may not exist yet (e.g. before first build)
  }
  return entries;
}

/**
 * Core files = everything under dist/ EXCEPT the isolated subpath dirs
 * (browser/, svelte/). Files in those subpaths are allowed to import
 * their respective heavy deps; the core must stay clean.
 */
function coreJsFiles(): string[] {
  const allJs = walkJsFiles(distDir);
  const isolated = [resolve(distDir, "browser"), resolve(distDir, "svelte")];
  return allJs.filter((f) => !isolated.some((dir) => f.startsWith(dir + "/")));
}

describe("Core SDK isolation from /browser and /svelte deps", () => {
  it("dist/index.js does not reference oauth-client-browser or svelte", () => {
    const indexPath = resolve(distDir, "index.js");
    const content = readFileSync(indexPath, "utf-8");
    expect(content).not.toContain("oauth-client-browser");
    expect(content).not.toContain('from "svelte"');
    expect(content).not.toContain("from 'svelte'");
  });

  it("no core file under dist/ references oauth-client-browser", () => {
    for (const file of coreJsFiles()) {
      const content = readFileSync(file, "utf-8");
      expect(content, `${file} references oauth-client-browser`).not.toContain(
        "oauth-client-browser",
      );
    }
  });

  it("no core file under dist/ imports from svelte", () => {
    for (const file of coreJsFiles()) {
      const content = readFileSync(file, "utf-8");
      expect(content, `${file} imports from svelte`).not.toContain(
        'from "svelte"',
      );
      expect(content, `${file} imports from svelte`).not.toContain(
        "from 'svelte'",
      );
    }
  });
});
