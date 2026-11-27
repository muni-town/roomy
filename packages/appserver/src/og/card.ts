/**
 * What an invite card shows, read from the appserver's own stores, and the
 * space's avatar, fetched and decoded for the renderer.
 *
 * Everything here is already public: `space.roomy.space.getMetadata` answers
 * name, description, avatar, handle and join policy to an anonymous caller for
 * any space, invite-only ones included, because the join screen needs them
 * before the visitor is a member (see that handler's comment). The member
 * count is the same aggregate `admin.listSpaces` sorts by. The card reveals
 * nothing a signed-out visitor to the join link could not already read.
 */

import { Jimp } from "jimp";
import { openGlobalDb } from "../db/db.ts";
import { getMetadataHandler } from "../handlers/space.roomy.space.getMetadata.ts";
import { resolvePdsEndpoint } from "../identity.ts";
import { XrpcError } from "../xrpc/errors.ts";
import type { AvatarImage, SpaceCardData } from "./render.ts";

/** A space's card data, plus the stored avatar reference it was read with. */
export interface SpaceCard extends SpaceCardData {
  /** `atblob://<did>/<cid>` or an `https://` URL, as stored. */
  avatarRef?: string;
}

/**
 * Read a space's card data, or `null` when there is no such space.
 *
 * The space's fields come from `getMetadataHandler` itself, called as an
 * anonymous caller, so the card shows exactly what that endpoint answers a
 * signed-out visitor — by construction, not by a second query that could
 * drift from it. Only the member count, which it doesn't carry, is read here.
 */
export async function loadSpaceCard(spaceId: string): Promise<SpaceCard | null> {
  let meta: Awaited<ReturnType<typeof getMetadataHandler>>;
  try {
    meta = await getMetadataHandler({ spaceId }, { did: null });
  } catch (err) {
    if (err instanceof XrpcError && err.status === 404) return null;
    throw err;
  }

  const stats = await openGlobalDb()
    .query("select member_count from space_stats where space_did = ?")
    .get<{ member_count: number }>(spaceId);

  const card: SpaceCard = {
    name: meta.name?.trim() || "A Roomy space",
    allowPublicJoin: meta.joinPolicy.allowPublicJoin,
  };
  const description = meta.description?.trim();
  if (description) card.description = description;
  if (meta.avatar) card.avatarRef = meta.avatar;
  if (meta.handle) card.handle = meta.handle;
  if (stats) card.memberCount = stats.member_count;
  return card;
}

/**
 * The space whose DNS handle is `handle`, or `null`. A join link may name the
 * space by handle (`/join?space=home.example.com`).
 */
export async function spaceForHandle(handle: string): Promise<string | null> {
  const row = await openGlobalDb()
    .query("select space_did from space_handles where handle = ? collate nocase limit 1")
    .get<{ space_did: string }>(handle.replace(/^@/, ""));
  return row?.space_did ?? null;
}

// ─── Avatar ───────────────────────────────────────────────────────────────

const AVATAR_TIMEOUT_MS = 4_000;
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Whether the appserver may fetch from `url`. The avatar URL is written by a
 * space admin and the PDS endpoint by whoever controls a DID document, so
 * neither is trusted to point somewhere public: only `https`, never an IP
 * literal, and never a name that only resolves inside a private network.
 */
export function isFetchableUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase();
  if (!host.includes(".")) return false; // `localhost`, bare service names
  if (host.startsWith("[") || /^[\d.]+$/.test(host)) return false; // IP literals
  return !/\.(localhost|local|internal|lan|home\.arpa)$/.test(host);
}

/** GET `url` and return its bytes, or `null` on any failure or oversize body. */
async function fetchBytes(url: string): Promise<Buffer | null> {
  if (!isFetchableUrl(url)) return null;
  try {
    const res = await fetch(url, {
      // A redirect could leave the checked host; an avatar has no need of one.
      redirect: "manual",
      signal: AbortSignal.timeout(AVATAR_TIMEOUT_MS),
      headers: { accept: "image/png,image/jpeg,image/gif,image/*;q=0.5" },
    });
    if (!res.ok || res.body === null) return null;
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > AVATAR_MAX_BYTES) return null;

    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of res.body) {
      total += chunk.byteLength;
      if (total > AVATAR_MAX_BYTES) return null;
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } catch {
    return null;
  }
}

/**
 * The most megapixels an avatar may declare. Decoding allocates
 * width × height × 4 bytes, and a flat image compresses to almost nothing, so
 * the byte cap alone does not bound memory: a 40 KB PNG can declare
 * 20000×20000. Each of Jimp's decoders checks this against the header and
 * refuses before allocating.
 */
const AVATAR_MAX_MP = 16;
export const DECODE_LIMITS = Object.fromEntries(
  ["image/png", "image/jpeg", "image/gif", "image/bmp", "image/x-ms-bmp", "image/tiff"].map(
    (mime) => [mime, { maxResolutionInMP: AVATAR_MAX_MP }],
  ),
) as Parameters<typeof Jimp.read>[1];

/**
 * Decode an avatar, or `null` when it is too large or not an image Jimp
 * reads (WebP, HEIC, SVG, anything else): the card then shows the initial.
 */
export async function decodeAvatar(bytes: Buffer | null): Promise<AvatarImage | null> {
  if (bytes === null) return null;
  try {
    return await Jimp.read(bytes, DECODE_LIMITS);
  } catch {
    return null;
  }
}

/** Split `atblob://<did>/<cid>`, or `null` when it is not one. */
export function parseAtblob(ref: string): { did: string; cid: string } | null {
  if (!ref.startsWith("atblob://")) return null;
  const rest = ref.slice("atblob://".length).split(/[?#]/)[0]!;
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const did = rest.slice(0, slash);
  const cid = rest.slice(slash + 1);
  if (!did.startsWith("did:") || !cid || cid.includes("/")) return null;
  return { did, cid };
}

/**
 * Fetch and decode a space avatar, or `null` when there is none to draw.
 *
 * A blob ref tries Bluesky's image CDN first, asking for its JPEG rendition so
 * a WebP or HEIC upload still decodes, then the owner's PDS for a blob the CDN
 * has not seen (space avatars on a Roomy-only PDS often are not there — see
 * `push/avatars.ts`). A URL is fetched as it is.
 */
export async function fetchAvatar(ref: string): Promise<AvatarImage | null> {
  const blob = parseAtblob(ref);
  if (blob === null) return decodeAvatar(await fetchBytes(ref));

  const did = encodeURIComponent(blob.did);
  const cid = encodeURIComponent(blob.cid);
  const fromCdn = await decodeAvatar(
    await fetchBytes(`https://cdn.bsky.app/img/avatar/plain/${did}/${cid}@jpeg`),
  );
  if (fromCdn) return fromCdn;

  let pds: string;
  try {
    pds = (await resolvePdsEndpoint(blob.did)).replace(/\/+$/, "");
  } catch {
    return null;
  }
  return decodeAvatar(
    await fetchBytes(`${pds}/xrpc/com.atproto.sync.getBlob?did=${did}&cid=${cid}`),
  );
}
