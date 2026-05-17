/**
 * Build-time smoke test: the core SDK entry (`@roomy-space/sdk`) must NOT
 * pull in `@atproto/oauth-client-browser` — that dependency is isolated
 * behind the `/browser` subpath export.
 *
 * This test imports the **built** `dist/index.js` (not `src/index.ts`) so
 * it reflects what downstream consumers actually resolve.  It checks the
 * resolved module tree for any reference to `oauth-client-browser`.
 *
 * Run via:  pnpm vitest run tests/smoke/no-browser-in-core.test.ts
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(__dirname, "../../dist");

const FORBIDDEN = "oauth-client-browser";

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

describe("Core SDK isolation from @atproto/oauth-client-browser", () => {
  it("dist/index.js does not reference oauth-client-browser", () => {
    const indexPath = resolve(distDir, "index.js");
    const content = readFileSync(indexPath, "utf-8");
    expect(content).not.toContain(FORBIDDEN);
  });

  it("no file under dist/ (outside dist/browser/) references oauth-client-browser", () => {
    const allJs = walkJsFiles(distDir);
    const browserDir = resolve(distDir, "browser");
    const coreFiles = allJs.filter((f) => !f.startsWith(browserDir + "/"));
    for (const file of coreFiles) {
      const content = readFileSync(file, "utf-8");
      expect(content).not.toContain(FORBIDDEN);
    }
  });
});
