import type { Agent } from "@atproto/api";
import type { ArbiterClient } from "./arbiter";

/**
 * Helpers for reading and writing a space's `app.bsky.actor.profile` record on
 * its stewarded account.
 *
 * The profile record lives in the space's own repo (`spaceDid`) on its
 * stewarded PDS. Reads are public data, so they go through the caller's PDS
 * via the `atproto-proxy` header (the standard pattern for reaching another
 * DID's PDS). Writes require acting under the space's account, which only the
 * arbiter can do — so they go through the arbiter's `proxy` procedure, whose
 * Rego policy grants Roomy space admins the ability to write records under the
 * space's account.
 */

/** The `app.bsky.actor.profile` record value (minus $type, which we set on write). */
export interface ProfileRecord {
  displayName?: string;
  description?: string;
}

const PROFILE_COLLECTION = "app.bsky.actor.profile";
const PROFILE_RKEY = "self";

/**
 * Read the space's Bluesky profile record, routed to the space's PDS via the
 * `atproto-proxy` header (public data, no auth). Returns `null` if the record
 * does not exist yet.
 */
export async function getSpaceProfileRecord(
  agent: Agent,
  spaceDid: string,
): Promise<ProfileRecord | null> {
  try {
    const resp = await agent.com.atproto.repo.getRecord(
      {
        repo: spaceDid,
        collection: PROFILE_COLLECTION,
        rkey: PROFILE_RKEY,
      },
      {
        headers: {
          "atproto-proxy": `${spaceDid}#atproto_pds`,
        },
      },
    );
    const value = resp.data.value;
    if (value == null || typeof value !== "object") return null;
    return value as unknown as ProfileRecord;
  } catch {
    // Record not found (or the space's PDS is unreachable) — treat as no profile.
    return null;
  }
}

/**
 * Create or update the space's Bluesky profile record via the arbiter proxy.
 * `putRecord` with rkey `self` upserts.
 */
export async function putProfileRecord(
  arbiter: ArbiterClient,
  spaceDid: string,
  profile: ProfileRecord,
): Promise<void> {
  await arbiter.proxy(spaceDid, {
    nsid: "com.atproto.repo.putRecord",
    method: "POST",
    body: {
      repo: spaceDid,
      collection: PROFILE_COLLECTION,
      rkey: PROFILE_RKEY,
      record: { $type: PROFILE_COLLECTION, ...profile },
    },
  });
}
