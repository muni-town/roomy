/**
 * Fetch Roomy profile records — `space.roomy.user.profile/self`.
 *
 * Two access patterns:
 *
 * 1. **Bulk (materialization):** Batched query to a HappyView index service
 *    (`space.roomy.user.getProfiles`). HappyView crawls the firehose and
 *    maintains an index of Roomy profile records, so bulk fetches are one
 *    batched HTTP call per 25 DIDs — no per-DID PDS round-trips.
 *
 * 2. **On-demand (getProfile handler):** Single-DID PDS fetch via
 *    `com.atproto.repo.getRecord` as a last-resort fallback when neither
 *    the materialized cache nor HappyView has the profile.
 */

import { AtpAgent } from "@atproto/api";
import type { ProfileViewDetailed } from "@atproto/api/dist/client/types/app/bsky/actor/defs";
import { resolvePdsEndpoint } from "../identity.ts";
import type { UserDid } from "@roomy-space/sdk";
import type { HappyViewConfig } from "../happyview.ts";

/** Shape of a `space.roomy.user.profile` record on the PDS. */
export interface RoomyProfileRecord {
  displayName?: string;
  description?: string;
  pronouns?: string;
  website?: string;
  avatar?: BlobRef;
  banner?: BlobRef;
  createdAt?: string;
}

/** ATProto blob ref as stored in a record. */
interface BlobRef {
  $type: "blob";
  ref: { $link: string };
  mimeType?: string;
  size?: number;
}

/** A Roomy profile as returned by HappyView (already resolved, with string blob refs). */
export interface HappyViewProfile {
  did: string;
  handle?: string;
  displayName?: string;
  description?: string;
  pronouns?: string;
  website?: string;
  avatar?: string;
  banner?: string;
}

const PROFILE_COLLECTION = "space.roomy.user.profile";
const PROFILE_RKEY = "self";

// ─── On-demand single-DID PDS fetch ──────────────────────────────────────

/**
 * Fetch the `space.roomy.user.profile/self` record from a user's PDS.
 * Used only by the on-demand `getProfile` handler as a last-resort fallback.
 *
 * Returns `null` if the record doesn't exist (user hasn't edited their Roomy
 * profile). Throws on network/DID-resolution failures.
 */
export async function getRoomyProfileRecord(
  did: string,
): Promise<RoomyProfileRecord | null> {
  const pdsEndpoint = await resolvePdsEndpoint(did);
  const agent = new AtpAgent({ service: pdsEndpoint });
  try {
    const resp = await agent.com.atproto.repo.getRecord({
      repo: did,
      collection: PROFILE_COLLECTION,
      rkey: PROFILE_RKEY,
    });
    return parseRoomyProfileRecord(resp.data.value);
  } catch (err) {
    if (isRecordNotFound(err)) return null;
    throw err;
  }
}

// ─── Batched HappyView fetch ──────────────────────────────────────────────

/**
 * Batch-fetch Roomy profile records from a HappyView index service.
 *
 * Queries `space.roomy.user.getProfiles` (max 25 DIDs per request). Returns
 * a map of DID → HappyViewProfile for DIDs that have a Roomy profile record.
 * DIDs without a record (or that errored) are omitted — the caller should
 * fall back to Bluesky for those.
 *
 * Returns an empty map if HappyView is not configured.
 */
export async function getProfilesFromHappyView(
  dids: UserDid[],
  config: HappyViewConfig,
): Promise<Map<string, HappyViewProfile>> {
  const results = new Map<string, HappyViewProfile>();
  if (dids.length === 0) return results;

  const MAX_ACTORS = 25;
  for (let i = 0; i < dids.length; i += MAX_ACTORS) {
    const chunk = dids.slice(i, i + MAX_ACTORS);
    try {
      const params = new URLSearchParams();
      for (const d of chunk) params.append("actors", d);
      const headers: Record<string, string> = {
        "X-Client-Key": config.clientKey,
      };
      if (config.clientSecret) {
        headers["X-Client-Secret"] = config.clientSecret;
      }
      const resp = await fetch(
        `${config.endpoint}/xrpc/space.roomy.user.getProfiles?${params.toString()}`,
        { headers },
      );
      if (!resp.ok) {
        console.warn(
          `[materialize] HappyView returned ${resp.status} for ${chunk.length} DIDs`,
        );
        continue;
      }
      const data = (await resp.json()) as { profiles?: HappyViewProfile[] };
      if (data.profiles) {
        for (const p of data.profiles) {
          results.set(p.did, p);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[materialize] HappyView chunk failed (${chunk.length} DIDs): ${message}`,
      );
    }
  }
  return results;
}

/**
 * Fetch a single Roomy profile record from HappyView using the default
 * query endpoint (`?did=<did>`).
 *
 * HappyView's default query handler returns `{ records: [...] }` where each
 * record is the raw stored record value. This function queries for a single
 * DID, extracts the `space.roomy.user.profile/self` record, and converts it
 * to a `HappyViewProfile`.
 *
 * Returns `null` when HappyView has no record for the DID, when the query
 * errors, or when HappyView is not configured.
 */
export async function getProfileFromHappyView(
  did: UserDid,
  config: HappyViewConfig,
): Promise<HappyViewProfile | null> {
  try {
    const headers: Record<string, string> = {
      "X-Client-Key": config.clientKey,
    };
    if (config.clientSecret) {
      headers["X-Client-Secret"] = config.clientSecret;
    }
    const resp = await fetch(
      `${config.endpoint}/xrpc/space.roomy.user.getProfiles?did=${encodeURIComponent(did)}`,
      { headers },
    );
    if (!resp.ok) {
      console.warn(
        `[materialize] HappyView returned ${resp.status} for DID ${did}`,
      );
      return null;
    }
    const data = (await resp.json()) as { records?: Array<Record<string, unknown>> };
    if (!data.records || data.records.length === 0) return null;

    // Find the profile record — there should be only one per DID (rkey=self).
    // The record value includes the raw record fields plus `uri` and `$type`.
    const rec = data.records[0]!;
    const record = parseRoomyProfileRecord(rec);
    if (!record) return null;

    return {
      did,
      displayName: record.displayName,
      description: record.description,
      pronouns: record.pronouns,
      website: record.website,
      avatar: record.avatar ? blobRefToAtblob(did, record.avatar) : undefined,
      banner: record.banner ? blobRefToAtblob(did, record.banner) : undefined,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[materialize] HappyView single-DID fetch failed: ${message}`);
    return null;
  }
}

// ─── Conversion helpers ──────────────────────────────────────────────────

/**
 * Convert a HappyView profile into the `ProfileViewDetailed`-compatible shape
 * that `insertProfilesWithExtras` expects. Blob ref strings (`atblob://…` or
 * `https://…`) are passed through as-is — HappyView serves them in the same
 * format the materializer stores.
 */
export function happyViewToProfileView(
  p: HappyViewProfile,
): ProfileViewDetailed {
  return {
    did: p.did,
    handle: p.handle ?? "",
    displayName: p.displayName,
    description: p.description,
    avatar: p.avatar,
  } as ProfileViewDetailed;
}

/** Extra Roomy-specific fields not in ProfileViewDetailed. */
export interface RoomyProfileExtras {
  pronouns?: string;
  website?: string;
  banner?: string;
}

/** Extract Roomy-specific extras from a HappyView profile. */
export function happyViewExtras(
  p: HappyViewProfile,
): RoomyProfileExtras {
  return {
    pronouns: p.pronouns,
    website: p.website,
    banner: p.banner,
  };
}

/** Convert a PDS-fetched Roomy record into a ProfileViewDetailed. */
export function roomyRecordToProfileView(
  did: string,
  record: RoomyProfileRecord,
): ProfileViewDetailed {
  return {
    did,
    handle: "",
    displayName: record.displayName,
    description: record.description,
    avatar: record.avatar ? blobRefToAtblob(did, record.avatar) : undefined,
  } as ProfileViewDetailed;
}

/** Extract Roomy extras from a PDS-fetched record. */
export function roomyRecordExtras(
  did: string,
  record: RoomyProfileRecord,
): RoomyProfileExtras {
  return {
    pronouns: record.pronouns,
    website: record.website,
    banner: record.banner ? blobRefToAtblob(did, record.banner) : undefined,
  };
}

/** Convert a blob ref to an `atblob://<did>/<cid>` string. */
function blobRefToAtblob(did: string, ref: BlobRef): string {
  return `atblob://${did}/${ref.ref.$link}`;
}

// ─── Type narrowing for PDS record values ─────────────────────────────────

/**
 * Type-narrow the raw record value from `getRecord` into a
 * `RoomyProfileRecord`. Validates only the fields we read; unknown
 * extra fields are ignored.
 */
function parseRoomyProfileRecord(
  value: unknown,
): RoomyProfileRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const record: RoomyProfileRecord = {};
  if (typeof v["displayName"] === "string") record.displayName = v["displayName"];
  if (typeof v["description"] === "string") record.description = v["description"];
  if (typeof v["pronouns"] === "string") record.pronouns = v["pronouns"];
  if (typeof v["website"] === "string") record.website = v["website"];
  if (typeof v["createdAt"] === "string") record.createdAt = v["createdAt"];
  record.avatar = parseBlobRef(v["avatar"]);
  record.banner = parseBlobRef(v["banner"]);
  return record;
}

/**
 * Narrow an unknown value to a blob ref, or undefined.
 *
 * Handles two representations:
 * 1. **Raw JSON** (from `fetch`): `{ $type: "blob", ref: { $link: "bafy..." } }`
 * 2. **Deserialised by `@atproto/api`**: `{ ref: CID, mimeType, size, original }`
 *    — the client strips `$type` and converts `ref` to a `CID` object whose
 *    `toString()` yields the CID string (e.g. `bafkrei...`).
 */
function parseBlobRef(value: unknown): BlobRef | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  // Accept both `$type: "blob"` (raw JSON) and the deserialised shape (no
  // `$type` but has a `ref` that is a CID or has `$link`).
  const isBlob = v["$type"] === "blob" || "ref" in v;
  if (!isBlob) return undefined;
  const ref = v["ref"];
  if (typeof ref !== "object" || ref === null) return undefined;
  // Raw JSON: ref is { $link: "bafy..." }
  const r = ref as Record<string, unknown>;
  let link: string | undefined;
  if (typeof r["$link"] === "string") {
    link = r["$link"];
  } else {
    // Deserialised CID: toString() yields the CID string (e.g. "bafkrei...")
    // Accept any string that looks like a CID — they start with "baf" (CIDv1)
    // or "ba" (legacy CIDv0). This is permissive but safe: a non-CID object
    // stringifying to something else won't match.
    const refStr = String(ref);
    if (refStr && /^ba[a-z0-9]+$/i.test(refStr)) {
      link = refStr;
    }
  }
  if (!link) return undefined;
  return {
    $type: "blob",
    ref: { $link: link },
    mimeType: typeof v["mimeType"] === "string" ? v["mimeType"] : undefined,
    size: typeof v["size"] === "number" ? v["size"] : undefined,
  };
}

/** Check if an error from `getRecord` is a RecordNotFound (no profile record). */
function isRecordNotFound(err: unknown): boolean {
  if (typeof err === "object" && err !== null && "error" in err) {
    return (err as { error: unknown }).error === "RecordNotFound";
  }
  return false;
}