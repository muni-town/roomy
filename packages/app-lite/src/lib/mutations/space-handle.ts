import {
  getSpaceHandle,
  getSpaceHandleDomains,
  setSpaceHandle,
  transport,
} from "@roomy-space/sdk";
import { createArbiterClient } from "$lib/arbiter";

/**
 * Read/set a space's handle on its stewarded account.
 *
 * Reading the available handle domains (and the current handle) is public PDS
 * config, resolved from the space's own PDS endpoint (not the caller's).
 * Setting the handle mutates the space's stewarded account, so it goes through
 * the space's arbiter (discovered per space from its
 * `town.muni.arbiter.service` record).
 */

/** Fetch the handle suffixes the space's PDS accepts (e.g. `.roomy.chat`). */
export async function getSpaceHandleDomainsForSpace(
  spaceId: string,
): Promise<string[]> {
  return getSpaceHandleDomains(spaceId);
}

/** Fetch the space's current handle (or null if none is set). */
export async function getCurrentSpaceHandle(
  spaceId: string,
): Promise<string | null> {
  return getSpaceHandle(spaceId);
}

/** Human-friendly messages for the upstream updateHandle error names. */
const HANDLE_ERROR_MESSAGES: Record<string, string> = {
  InvalidHandle: "That isn't a valid handle.",
  HandleNotAvailable:
    "That handle is already taken. Try a different one.",
  UnsupportedDomain:
    "That handle uses a domain this space's account doesn't support.",
  UnresolvableDid: "The handle didn't resolve to a DID we can use.",
  IncompatibleDidDoc: "The handle's DID document isn't compatible with this account.",
  InvalidPassword: "The space's account credentials are invalid.",
};

/**
 * Set the space's handle on its stewarded account via the arbiter. Throws a
 * `Error` with a human-friendly message on failure (mapping known PDS error
 * codes like `HandleNotAvailable` → "already taken").
 */
export async function setSpaceHandleForSpace(
  spaceId: string,
  handle: string,
): Promise<void> {
  const arbiter = createArbiterClient();
  try {
    await setSpaceHandle(arbiter, spaceId, handle);
  } catch (err) {
    if (err instanceof transport.ArbiterProxyError && err.errorName) {
      const friendly = HANDLE_ERROR_MESSAGES[err.errorName];
      if (friendly) throw new Error(friendly);
      throw new Error(`Could not set the space handle: ${err.errorName}`);
    }
    throw err;
  }
}
