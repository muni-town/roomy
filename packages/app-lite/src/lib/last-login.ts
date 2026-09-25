/**
 * The "Previously signed in as" record (`localStorage["last-login"]`).
 *
 * This record is the only client-side memory of a signed-out identity, and it
 * is what the login screen offers as a one-click sign-in. It is written by
 * `updateProfile()` on a successful profile fetch and read by `LoginModal`
 * and `SidebarUserCard`.
 *
 * **Why this module exists.** The stored `handle` is a *snapshot* taken at
 * profile-fetch time, but handles are mutable: a user can rename, or lose the
 * domain their handle lives on. The record outlives the handle it names, and a
 * snapshot trusted forever can name a handle that no longer resolves — offering
 * it fails in identity resolution ("Failed to resolve identity: <handle>"). The
 * record is therefore never trusted on its own:
 *
 * - `did` is the durable identity; the handle is treated as a cache of it.
 * - Before a record is offered, its handle is re-checked against the DID it was
 *   stored with (via the public Bluesky appview — unauthenticated and
 *   CORS-enabled, and already the handle source used by `HandleTypeahead` and
 *   by the appserver's own profile fallback).
 * - A handle that no longer matches the DID is repaired from the DID's current
 *   handle; a DID with no usable handle drops the record entirely.
 *
 * The check fails *closed*: when the appview cannot be reached the record is
 * withheld (a handle we cannot verify is exactly the kind that fails resolution)
 * but not deleted, so a later successful check can offer it again. The
 * user can still type their handle in the meantime.
 *
 * The record is deliberately **not** cleared on logout: it exists precisely to
 * offer a signed-out user their previous identity, so clearing it at logout
 * would delete the feature rather than fix it.
 *
 * The logic here is storage- and network-injected so it is testable without a
 * DOM; the reactive wrapper lives in `last-login.svelte.ts`.
 */

/** Sentinel the appview returns for a DID whose handle no longer resolves. */
const HANDLE_INVALID = "handle.invalid";

/** Public Bluesky appview — unauthenticated, `access-control-allow-origin: *`. */
const APPVIEW = "https://api.bsky.app";

export const LAST_LOGIN_KEY = "last-login";

export interface LastLogin {
  handle: string;
  did: string;
  avatar: string;
  displayName?: string;
}

/** The subset of `Storage` this module needs (and that tests can fake). */
export interface LastLoginStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** `localStorage` when a DOM is present; `null` during SSR / in tests. */
function defaultStorage(): LastLoginStorage | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}

/**
 * Parse a stored record, rejecting anything without a usable handle + DID —
 * including the `handle.invalid` sentinel, which is never a sign-in target.
 */
export function parseLastLogin(raw: string | null): LastLogin | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<LastLogin> | null;
    if (!parsed || typeof parsed.did !== "string" || !parsed.did) return null;
    if (typeof parsed.handle !== "string" || !parsed.handle) return null;
    if (parsed.handle === HANDLE_INVALID) return null;
    return {
      handle: parsed.handle,
      did: parsed.did,
      avatar: typeof parsed.avatar === "string" ? parsed.avatar : "",
      displayName:
        typeof parsed.displayName === "string" ? parsed.displayName : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * The DID's current handle.
 *
 * - `string`    — the handle it resolves to now.
 * - `null`      — the appview answered definitively that the DID has no usable
 *                 handle (unknown DID, or the `handle.invalid` sentinel).
 * - `undefined` — the answer could not be obtained (offline, 5xx, rate limit).
 *                 Callers must NOT read this as "no handle".
 */
export async function fetchCurrentHandle(
  did: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null | undefined> {
  try {
    const url = new URL("/xrpc/app.bsky.actor.getProfile", APPVIEW);
    url.searchParams.set("actor", did);
    const resp = await fetchImpl(url, {
      headers: [["accept", "application/json"]],
    });
    if (resp.ok) {
      const data = (await resp.json()) as { handle?: unknown };
      const handle = typeof data?.handle === "string" ? data.handle : "";
      return handle && handle !== HANDLE_INVALID ? handle : null;
    }
    // 400 InvalidRequest ("Profile not found") — the appview answered about
    // this DID and it has no profile. That answer is final.
    if (resp.status === 400) return null;
    return undefined;
  } catch {
    return undefined;
  }
}

export interface LastLoginDecision {
  /** The record that may be offered, or `null` when none may be. */
  record: LastLogin | null;
  /** Record to persist (a repaired handle), or `null` to leave storage alone. */
  persist: LastLogin | null;
  /** Stored record is permanently dead — remove it from storage. */
  remove: boolean;
}

/**
 * Decide what to offer given the stored record and what the DID resolves to.
 *
 * A handle may only be offered when the DID's live handle matches it (or has
 * been repaired from it); everything else — a dead handle, a DID with no
 * handle, or a check that could not be completed — yields `record: null`.
 */
export function decideLastLogin(
  stored: LastLogin | null,
  current: string | null | undefined,
): LastLoginDecision {
  if (!stored) return { record: null, persist: null, remove: false };

  // Unverifiable → withhold for this session, keep for a later attempt.
  if (current === undefined) return { record: null, persist: null, remove: false };

  // Verified: the DID has no usable handle. The stored identity is gone.
  if (current === null) return { record: null, persist: null, remove: true };

  // Handle changed since the snapshot — offer the live one, repair storage.
  if (current !== stored.handle) {
    const repaired: LastLogin = { ...stored, handle: current };
    return { record: repaired, persist: repaired, remove: false };
  }

  return { record: stored, persist: null, remove: false };
}

/**
 * Read, verify and reconcile the stored record against its DID.
 *
 * Returns the record that may be offered as a sign-in affordance, or `null`
 * when none may be (no record, dead handle, or the check could not complete).
 */
export async function verifyLastLogin(opts?: {
  storage?: LastLoginStorage | null;
  fetch?: typeof fetch;
}): Promise<LastLogin | null> {
  const storage = opts?.storage === undefined ? defaultStorage() : opts.storage;
  if (!storage) return null;

  const stored = parseLastLogin(storage.getItem(LAST_LOGIN_KEY));
  const current = stored
    ? await fetchCurrentHandle(stored.did, opts?.fetch ?? fetch)
    : undefined;
  const decision = decideLastLogin(stored, current);

  if (decision.remove) storage.removeItem(LAST_LOGIN_KEY);
  else if (decision.persist)
    storage.setItem(LAST_LOGIN_KEY, JSON.stringify(decision.persist));

  return decision.record;
}
