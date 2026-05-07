/**
 * Admin DID allowlist + request guard.
 *
 * Reads `APPSERVER_ADMIN_DIDS` (comma-separated) at module load. The list is
 * the authoritative gate for the debug endpoints — and, eventually, an admin
 * web UI sharing the same surface.
 *
 * Fails closed: an unset or empty allowlist locks the endpoints out entirely.
 * Set at least one DID in development.
 */

import { prodAuthVerifier } from "./xrpc/auth.ts";
import { XrpcError, toErrorResponse } from "./xrpc/errors.ts";

const RAW = process.env.APPSERVER_ADMIN_DIDS ?? "";

export const ADMIN_DIDS: ReadonlySet<string> = new Set(
  RAW.split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0),
);

if (ADMIN_DIDS.size === 0) {
  console.warn(
    "[admin] APPSERVER_ADMIN_DIDS is unset; admin/debug endpoints will reject all requests. " +
      "Set a comma-separated list of DIDs (e.g. did:plc:abc...,did:web:foo.bar) to allow access.",
  );
} else {
  console.info(
    `[admin] APPSERVER_ADMIN_DIDS configured with ${ADMIN_DIDS.size} DID(s)`,
  );
}

export interface AdminCtx {
  did: string;
}

/**
 * Verify the request bears a valid inter-service JWT and the caller's DID is
 * on the admin allowlist. Throws `XrpcError(401|403)` otherwise.
 */
export async function requireAdmin(req: Request): Promise<AdminCtx> {
  const ctx = await prodAuthVerifier(req);
  if (!ADMIN_DIDS.has(ctx.did)) {
    throw new XrpcError(
      403,
      "Forbidden",
      "Caller DID is not on the admin allowlist",
    );
  }
  return ctx;
}

/**
 * Run a request handler under the admin guard, converting `XrpcError`s into
 * the appserver's standard error response shape.
 */
export async function withAdmin(
  req: Request,
  handler: (admin: AdminCtx) => Promise<Response>,
): Promise<Response> {
  try {
    const admin = await requireAdmin(req);
    return await handler(admin);
  } catch (err) {
    return toErrorResponse(err);
  }
}
