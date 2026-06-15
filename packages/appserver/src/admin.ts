/**
 * Admin DID allowlist.
 *
 * Reads `APPSERVER_ADMIN_DIDS` (comma-separated) at module load. The list is
 * the authoritative gate for admin XRPC procedures and any future admin UI
 * surface.
 *
 * Fails closed: an unset or empty allowlist locks admin endpoints out
 * entirely. Set at least one DID in development.
 */

import { XrpcError } from "./xrpc/errors.ts";
import type { AuthCtx } from "./xrpc/types.ts";

const RAW = process.env.APPSERVER_ADMIN_DIDS ?? "";

export const ADMIN_DIDS: ReadonlySet<string> = new Set(
  RAW.split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0),
);

if (ADMIN_DIDS.size === 0) {
  console.warn(
    "[admin] APPSERVER_ADMIN_DIDS is unset; admin endpoints will reject all requests. " +
      "Set a comma-separated list of DIDs (e.g. did:plc:abc...,did:web:foo.bar) to allow access.",
  );
} else {
  console.info(
    `[admin] APPSERVER_ADMIN_DIDS configured with ${ADMIN_DIDS.size} DID(s)`,
  );
}

/**
 * Throws `XrpcError(403)` if the caller is not on the admin allowlist.
 * Intended for use inside XRPC handlers — the router has already verified
 * the caller's JWT and produced the AuthCtx.
 */
export function requireAdmin(auth: AuthCtx): void {
  if (auth.did === null || !ADMIN_DIDS.has(auth.did)) {
    throw new XrpcError(
      403,
      "Forbidden",
      "Caller DID is not on the admin allowlist",
    );
  }
}
