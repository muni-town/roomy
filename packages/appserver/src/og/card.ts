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
import { openGlobalDb, openSpaceDb, spaceExists } from "../db/db.ts";
import { resolvePdsEndpoint } from "../identity.ts";
import { getSpaceHandle } from "../queries/spaceHandles.ts";
import type { AvatarImage, SpaceCardData } from "./render.ts";

/** A space's card data, plus the stored avatar reference it was read with. */
export interface SpaceCard extends SpaceCardData {
  /** `atblob://<did>/<cid>` or an `https://` URL, as stored. */
  avatarRef?: string;
}

/**
 * Read a space's card data, or `null` when there is no such space.
 *
 * `spaceExists` comes first because opening a space DB creates it: an unknown
 * id must not leave an empty database behind (the same rule `getMetadata`
 * follows).
 */
export async function loadSpaceCard(spaceId: string): Promise<SpaceCard | null> {
  if (!(await spaceExists(spaceId))) return null;

  const row = await openSpaceDb(spaceId)
    .query(
      `select ci.name as name,
              ci.avatar as avatar,
              ci.description as description,
              cs.allow_public_join as allow_public_join
         from comp_space cs
         left join comp_info ci on ci.entity = cs.entity
        where cs.entity = ?`,
    )
    .get<{
      name: string | null;
      avatar: string | null;
      description: string | null;
      allow_public_join: number | null;
    }>(spaceId);
  if (row === null) return null;

  const globalDb = openGlobalDb();
  const [handle, stats] = await Promise.all([
    getSpaceHandle(spaceId, globalDb),
    globalDb
      .query("select member_count from space_stats where space_did = ?")
      .get<{ member_count: number }>(spaceId),
  ]);

  const card: SpaceCard = {
    name: row.name?.trim() || "A Roomy space",
    // NULL is open: the access check reads `coalesce(allow_public_join, 1)`.
    allowPublicJoin: row.allow_public_join !== 0,
  };
  const description = row.description?.trim();
  if (description) card.description = description;
  if (row.avatar) card.avatarRef = row.avatar;
  if (handle) card.handle = handle;
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
 * The most pixels an avatar may declare. Decoding allocates width × height × 4
 * bytes up front, and a flat image compresses to almost nothing, so the byte
 * cap alone does not bound memory: a 40 KB PNG can declare 20000×20000.
 */
const AVATAR_MAX_PIXELS = 16_000_000;

/**
 * The dimensions a PNG, GIF or JPEG header declares, or `null` for anything
 * else (which is then not decoded).
 */
export function imageDimensions(bytes: Buffer): { width: number; height: number } | null {
  // PNG: signature, then IHDR's width and height.
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  // GIF: logical screen size, little-endian.
  if (bytes.length >= 10 && bytes.toString("ascii", 0, 3) === "GIF") {
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  // JPEG: walk the segments to the first start-of-frame.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return null;
      const marker = bytes[i + 1]!;
      if (marker === 0xff) {
        i += 1; // fill byte
        continue;
      }
      const isFrame =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) {
        return { width: bytes.readUInt16BE(i + 7), height: bytes.readUInt16BE(i + 5) };
      }
      i += 2 + bytes.readUInt16BE(i + 2);
    }
  }
  return null;
}

/** Decode a PNG, GIF or JPEG avatar of a sane size, or `null`. */
async function decode(bytes: Buffer | null): Promise<AvatarImage | null> {
  if (bytes === null) return null;
  const size = imageDimensions(bytes);
  if (size === null || size.width * size.height > AVATAR_MAX_PIXELS) return null;
  try {
    return await Jimp.read(bytes);
  } catch {
    // WebP, HEIC, SVG or not an image at all: the card falls back to the initial.
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
  if (blob === null) return decode(await fetchBytes(ref));

  const did = encodeURIComponent(blob.did);
  const cid = encodeURIComponent(blob.cid);
  const fromCdn = await decode(
    await fetchBytes(`https://cdn.bsky.app/img/avatar/plain/${did}/${cid}@jpeg`),
  );
  if (fromCdn) return fromCdn;

  let pds: string;
  try {
    pds = (await resolvePdsEndpoint(blob.did)).replace(/\/+$/, "");
  } catch {
    return null;
  }
  return decode(
    await fetchBytes(`${pds}/xrpc/com.atproto.sync.getBlob?did=${did}&cid=${cid}`),
  );
}
