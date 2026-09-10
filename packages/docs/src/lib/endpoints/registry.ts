/**
 * Endpoint catalogue — merges the generated skeleton (NSID + kind + group,
 * from the appserver router) with hand-written prose (descriptions, schemas,
 * notes).
 *
 * - `nsids.generated.json` — emitted by `scripts/generate-registry.ts` from
 *   `packages/appserver/src/appserver.ts`'s `buildRouter()`. Regenerate with
 *   `pnpm --filter docs generate:registry`; CI checks it with
 *   `pnpm --filter docs check:registry`.
 * - `prose.ts` — hand-authored documentation keyed by NSID.
 */

import { prose, type EndpointParam, type EndpointSchema } from "./prose";
import generated from "./nsids.generated.json";

export type { EndpointParam, EndpointSchema } from "./prose";

/** Shape of one entry in `nsids.generated.json` (see scripts/generate-registry.ts). */
interface GeneratedNsid {
  nsid: string;
  kind: "query" | "procedure" | "sync";
  group: string;
}

export interface Endpoint {
  nsid: string;
  kind: "query" | "procedure" | "sync";
  group: string;
  description: string;
  auth: string;
  params?: EndpointParam[];
  inputSchema?: EndpointSchema;
  outputSchema?: EndpointSchema;
  notes?: string[];
  invalidation?: string[];
  /** True when this endpoint is admin-only (appserver allowlist). */
  adminOnly: boolean;
}

export interface EndpointGroup {
  name: string;
  items: Endpoint[];
}

const ADMIN_NSID_PREFIXES = ["space.roomy.admin.", "space.roomy.sync.getEvents"];

function isAdminOnly(nsid: string): boolean {
  return ADMIN_NSID_PREFIXES.some((p) => nsid.startsWith(p));
}

function buildEndpoint(entry: GeneratedNsid): Endpoint {
  const p = prose[entry.nsid];
  if (!p) {
    throw new Error(
      `No prose for registered NSID ${entry.nsid} — add it to src/lib/endpoints/prose.ts`,
    );
  }
  return {
    nsid: entry.nsid,
    kind: entry.kind,
    group: entry.group,
    description: p.description,
    auth: p.auth,
    params: p.params,
    inputSchema: p.inputSchema,
    outputSchema: p.outputSchema,
    notes: p.notes,
    invalidation: p.invalidation,
    adminOnly: isAdminOnly(entry.nsid),
  };
}

export const endpoints: EndpointGroup[] = (() => {
  const groups = new Map<string, Endpoint[]>();
  // JSON import widens `kind` to string; the generator guarantees the union.
  for (const entry of generated as GeneratedNsid[]) {
    const ep = buildEndpoint(entry);
    const list = groups.get(ep.group) ?? [];
    list.push(ep);
    groups.set(ep.group, list);
  }
  return [...groups.entries()].map(([name, items]) => ({ name, items }));
})();

/** Flatten all endpoints for lookup by NSID. */
export const endpointByNsid: Record<string, Endpoint> = {};
for (const group of endpoints) {
  for (const ep of group.items) {
    endpointByNsid[ep.nsid] = ep;
  }
}
