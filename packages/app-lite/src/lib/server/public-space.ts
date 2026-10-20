/**
 * Anonymous XRPC reads for server loads — the read path behind a
 * server-rendered `<head>`.
 *
 * The module sits under `$lib/server` so the bundler, not convention, keeps it
 * out of the client bundle: SvelteKit refuses to import a `$lib/server` module
 * from client code.
 *
 * Three rules it carries:

 * - **No caller credentials, ever.** The reads are `fetch`es with no
 *   `Authorization` and no cookies, using the global `fetch` rather than the
 *   load's `event.fetch` — so there is no per-request header bag to inherit
 *   from. The response is therefore safe to hand to anyone, which is what lets
 *   the document it renders be cached publicly downstream.
 * - **`null`, not a throw.** A space that does not exist, a room in an
 *   invite-only space, a rate limit and a network failure are one outcome for
 *   the head: fall back to the site defaults and serve the document anyway.
 *   The document must be served in every case.
 * - **One request per URL per minute, at most.** The appserver rate-limits per
 *   client IP *before* its response cache, and this process is one client for
 *   every visitor, so a rendered document must not map 1:1 onto an XRPC call.
 *   `read-cache.ts` holds a success for the window the appserver would itself
 *   have cached it, and folds concurrent renders of one URL into one request.
 */

import { env } from "$env/dynamic/private";
import { transport } from "@roomy-space/sdk";
import { CONFIG } from "$lib/config";
import { createReadCache } from "./read-cache";

const { resolveAppserverHttpOrigin } = transport;

/**
 * How long an anonymous read may take before the head gives up on it. A
 * degraded head costs a link preview; a head that waits on an unresponsive
 * appserver costs the document, so the read is bounded well below any origin's
 * own timeout.
 */
const XRPC_TIMEOUT_MS = 5_000;

/**
 * The window a successful read is reused for.
 *
 * It matches the appserver's own default response-cache TTL: past it, the
 * appserver would recompute the answer anyway, so serving the held value
 * costs a head nothing it could have had by asking again.
 */
const READ_TTL_MS = 60_000;

/**
 * How many distinct reads are held at once. Each is a small metadata object;
 * the cap is what keeps a crawler walking arbitrary space DIDs from turning
 * the cache into the leak the rate limit exists to prevent.
 */
const READ_CACHE_ENTRIES = 512;

const reads = createReadCache({
  ttlMs: READ_TTL_MS,
  maxEntries: READ_CACHE_ENTRIES,
});

/**
 * The appserver origin this process reads from, resolved once.
 *
 * `CONFIG.appserverHttpOrigin` is the local-development override (and the
 * e2e stack's): both are known before any request. In production it is null,
 * and the origin is only discoverable from the appserver's DID document, so
 * that resolution is cached here rather than repeated per request — an SSR
 * origin is one client for every visitor.
 *
 * A resolution failure is not cached, so a transient one does not leave the
 * process without an appserver for its lifetime.
 */
let cachedOrigin: string | null = null;

export async function serverAppserverOrigin(): Promise<string | null> {
  if (cachedOrigin) return cachedOrigin;

  const configured =
    env.APP_SERVER_HTTP_ORIGIN?.trim() || CONFIG.appserverHttpOrigin;
  if (configured) {
    cachedOrigin = configured.replace(/\/+$/, "");
    return cachedOrigin;
  }

  try {
    cachedOrigin = await resolveAppserverHttpOrigin(CONFIG.appserverDid);
    return cachedOrigin;
  } catch {
    return null;
  }
}

/** An anonymous XRPC GET, or `null` for every way it can fail. */
export async function publicXrpc<T>(
  nsid: string,
  params: Record<string, string>,
): Promise<T | null> {
  const origin = await serverAppserverOrigin();
  if (!origin) return null;

  const url = new URL(`/xrpc/${nsid}`, origin);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  return reads.readThrough(url.href, async () => {
    try {
      const res = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(XRPC_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      return null;
    }
  });
}

/** The `space.roomy.space.getMetadata` fields an unfurl of a space reads. */
export interface PublicSpaceMeta {
  name?: string;
  description?: string;
  avatar?: string;
}

/** The `space.roomy.room.getMetadata` fields an unfurl of a room reads. */
export interface PublicRoomMeta {
  name?: string;
}

/** The `space.roomy.user.getProfile` fields an unfurl of a profile reads. */
export interface PublicProfileMeta {
  displayName?: string;
  handle?: string;
  description?: string;
  avatar?: string;
}
