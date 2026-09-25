/**
 * Reactive binding for the "Previously signed in as" record.
 *
 * All decision logic lives in `last-login.ts` (storage- and network-injected,
 * unit-tested); this module only holds the `$state` the UI renders from and
 * exposes the mutators the app calls.
 *
 * `current` is seeded *only* by verification, never from storage directly: a
 * snapshot offered during the verification round-trip would let a click reach
 * the PDS with a dead handle.
 */

import {
  LAST_LOGIN_KEY,
  verifyLastLogin,
  type LastLogin,
} from "./last-login";

export type { LastLogin } from "./last-login";

let record = $state<LastLogin | null>(null);

export const lastLogin = {
  /**
   * The verified record, for synchronous rendering. `null` until the DID check
   * confirms the stored handle still resolves, so callers never offer a handle
   * from anywhere else.
   */
  get current(): LastLogin | null {
    return record;
  },
};

/**
 * Verify the stored record against its DID, publishing the result for render.
 * Call once at startup; safe to re-run.
 */
export async function loadLastLogin(): Promise<LastLogin | null> {
  const verified = await verifyLastLogin();
  record = verified;
  return verified;
}

/**
 * Replace the stored record. Called on a successful profile fetch, where the
 * handle is freshly read from the appserver and therefore already trustworthy.
 */
export function saveLastLogin(next: LastLogin): void {
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(LAST_LOGIN_KEY, JSON.stringify(next));
  }
  record = next;
}

/** Drop the stored record. */
export function clearLastLogin(): void {
  if (typeof localStorage !== "undefined") {
    localStorage.removeItem(LAST_LOGIN_KEY);
  }
  record = null;
}
