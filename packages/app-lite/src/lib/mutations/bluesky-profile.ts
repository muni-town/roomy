import {
  getSpaceProfileRecord,
  putProfileRecord,
  uploadBlobToSpace,
  transport,
  ArbiterClient,
  type ProfileRecord,
} from "@roomy-space/sdk";
import { auth } from "$lib/auth.svelte";
import { createArbiterClient } from "$lib/arbiter";

/** The `app.bsky.actor.profile` avatar blob limit (bsky lexicon constraint). */
const MAX_AVATAR_BYTES = 1_000_000;

/**
 * Read/write a space's Bluesky profile (app.bsky.actor.profile).
 *
 * Reads go straight to the space's PDS via the `atproto-proxy` header (public
 * data, no auth). Writes go through the space's arbiter — discovered per space
 * from its `town.muni.arbiter.service` record — via the arbiter's `proxy`
 * procedure, whose Rego policy grants Roomy space admins the ability to write
 * records under the space's account.
 *
 * Returns `hasProfile: false` when the space has no Bluesky profile record
 * yet, so the UI can show "Create" vs "Update".
 */
export interface SpaceBlueskyProfileState {
  hasProfile: boolean;
  displayName: string | null;
  description: string | null;
}

/** Fetch the space's current Bluesky profile state (direct PDS read). */
export async function getBlueskyProfile(
  spaceId: string,
): Promise<SpaceBlueskyProfileState> {
  const agent = auth.agent;
  if (!agent) throw new Error("Not authenticated");
  const record = await getSpaceProfileRecord(agent, spaceId);
  if (!record) return { hasProfile: false, displayName: null, description: null };
  return {
    hasProfile: true,
    displayName: record.displayName ?? null,
    description: record.description ?? null,
  };
}

/**
 * Create or update the space's Bluesky profile using the space's name,
 * description, and avatar. The space's avatar (an `atblob://<did>/<cid>`
 * image) is fetched and uploaded to the space's own PDS repo via the arbiter
 * before being embedded in the profile record. The upload is skipped when the
 * profile already carries the same (content-addressed) blob, and an existing
 * avatar is preserved when no new one is supplied — `putRecord` replaces the
 * whole record, so anything omitted would be silently dropped.
 */
export async function upsertBlueskyProfile(
  spaceId: string,
  opts: { displayName?: string; description?: string; avatarUri?: string },
): Promise<void> {
  const arbiter = createArbiterClient();
  const agent = auth.agent;
  if (!agent) throw new Error("Not authenticated");

  const current = await getSpaceProfileRecord(agent, spaceId);

  let avatar: ProfileRecord["avatar"] | undefined;
  if (opts.avatarUri?.startsWith("atblob://")) {
    const parsed = parseAtblobUri(opts.avatarUri);
    if (!parsed) throw new Error("Invalid avatar blob URI");
    const existing = current?.avatar;
    if (existing?.ref?.$link === parsed.cid) {
      // Unchanged avatar — blob CIDs are derived from the bytes, so the
      // profile already carries the identical blob: skip the round-trip.
      avatar = existing;
    } else {
      avatar = await uploadAvatar(arbiter, spaceId, parsed);
    }
  } else if (current?.avatar) {
    // No new avatar supplied — keep the one already on the profile.
    avatar = current.avatar;
  }

  await putProfileRecord(arbiter, spaceId, {
    ...(opts.displayName ? { displayName: opts.displayName } : {}),
    ...(opts.description ? { description: opts.description } : {}),
    ...(avatar ? { avatar } : {}),
  });
}

/** Parse an `atblob://<did>/<cid>` URI. Returns `null` when malformed. */
function parseAtblobUri(uri: string): { did: string; cid: string } | null {
  const rest = uri.slice("atblob://".length).split(/[?#]/)[0]!;
  const slash = rest.indexOf("/");
  if (slash === -1) return null;
  const did = rest.slice(0, slash);
  const cid = rest.slice(slash + 1);
  if (!did || !cid) return null;
  return { did, cid };
}

/**
 * Fetch an atblob:// image from its owner's PDS and upload it to the space's
 * PDS repo. Enforces the `app.bsky.actor.profile` avatar constraints
 * (PNG/JPEG, ≤ 1 MB) up front so a non-conforming avatar fails here with a
 * clear message instead of after the blob has been stored.
 */
async function uploadAvatar(
  arbiter: ArbiterClient,
  spaceId: string,
  blob: { did: string; cid: string },
) {
  const { did, cid } = blob;

  // Fetch the original blob bytes from the owner's PDS directly
  // (`com.atproto.sync.getBlob` is public, unauthenticated). Using the CDN
  // (`cdn.bsky.app`) would fail on CORS since it doesn't send
  // `Access-Control-Allow-Origin`.
  const pds = await transport.resolvePdsEndpoint(did);
  const url = `${pds}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(cid)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch space avatar: ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const contentType = res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";

  if (contentType !== "image/png" && contentType !== "image/jpeg") {
    throw new Error(
      `Unsupported avatar type (${contentType || "unknown"}): the Bluesky profile avatar must be a PNG or JPEG image`,
    );
  }
  if (bytes.length > MAX_AVATAR_BYTES) {
    throw new Error(
      `Avatar image too large (${bytes.length} bytes): the Bluesky profile avatar must be at most ${MAX_AVATAR_BYTES} bytes`,
    );
  }

  return uploadBlobToSpace(arbiter, spaceId, bytes, contentType);
}
