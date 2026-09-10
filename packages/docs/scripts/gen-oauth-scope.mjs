/**
 * Generate the OAuth scope string for the docs site's OAuth client metadata.
 *
 * The scope is derived from the endpoint catalogue (nsids.generated.json) so
 * it can't drift: every registered XRPC method gets an `rpc:<nsid>?aud=*`
 * scope, plus the base `atproto` scope and the PDS RPCs the site needs
 * (profile lookup, service auth). Admin endpoints are included — the
 * appserver still enforces its own admin allowlist, so non-admins simply get
 * 403s.
 *
 * Plain .mjs (no tsx) so it runs in the Docker build, which only installs the
 * docs/sdk/design/tsconfig workspace deps.
 *
 * Usage: node scripts/gen-oauth-scope.mjs
 * Output: a single space-separated scope string on stdout.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const generated = JSON.parse(
  readFileSync(join(THIS_DIR, "..", "src", "lib", "endpoints", "nsids.generated.json"), "utf8"),
);

const appserverDid = process.env.VITE_APPSERVER_DID ?? "did:web:api.roomy.space";

const scopes = new Set([
  "atproto",
  "rpc:app.bsky.actor.getProfile?aud=*",
  `rpc:com.atproto.server.getServiceAuth?aud=${appserverDid}`,
]);

for (const entry of generated) {
  scopes.add(`rpc:${entry.nsid}?aud=*`);
}

process.stdout.write([...scopes].join(" ") + "\n");
