/**
 * Publish a Web Tile from `packages/appserver/tiles/<name>/` to a PDS.
 *
 * A tile published over AT Protocol is an `ing.dasl.masl` record: every entry
 * of the manifest's `resources` map is uploaded as a blob, referenced from the
 * record as a blob ref (`$type: "blob"`, because a PDS garbage-collects content
 * only a CID names), and the record carries the manifest plus the DRISL CID of
 * that manifest.
 *
 * The source manifest in the tile's directory is the manifest itself with one
 * substitution: a resource names the file to upload (`file`) instead of the
 * blob it will become (`src`). Uploading is the only thing this script adds, so
 * what a reader of the directory sees is what gets published.
 *
 * Credentials come from the environment and are never stored here:
 *
 *   ATPROTO_IDENTIFIER    the publishing account's handle or DID
 *   ATPROTO_APP_PASSWORD  an app password for it
 *   ATPROTO_PDS           its PDS, e.g. https://roomy.chat
 *
 * Usage: bun run scripts/publish-tile.ts [tile-name]
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { AtpAgent } from "@atproto/api";
import { CidLinkWrapper, encode } from "@atcute/cbor";
import { TILE_COLLECTION } from "../src/embed/tiles.ts";

/** One entry of the source manifest: the file to upload and its headers. */
interface SourceResource {
  file: string;
  "content-type"?: string;
}

interface SourceManifest {
  resources: Record<string, SourceResource>;
  [key: string]: unknown;
}

/** The `$type` a PDS requires on an uploaded blob's reference. */
interface BlobRef {
  $type: "blob";
  ref: { $link: string };
  mimeType: string;
  size: number;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set (see this script's header)`);
  }
  return value;
}

/**
 * The DRISL CID of a manifest: CIDv1 over the DRISL (deterministic CBOR,
 * dag-cbor codec 0x71) encoding of the manifest, SHA-256 digested.
 *
 * Both parts are fixed by the spec's CID profile — version 1, codec 0x71 for
 * structured data, SHA-256, 32-byte digest — so the bytes are assembled here
 * rather than pulled in with a multiformats dependency. `CidLinkWrapper`
 * supplies the base32 encoding the `$link` string needs.
 */
function manifestCid(manifest: unknown): string {
  const digest = createHash("sha256")
    .update(encode(manifest))
    .digest();
  const bytes = new Uint8Array(4 + digest.length);
  bytes.set([0x01, 0x71, 0x12, 0x20], 0);
  bytes.set(digest, 4);
  return new CidLinkWrapper(bytes).$link;
}

async function main(): Promise<void> {
  const name = process.argv[2] ?? "bluesky-post";
  const dir = resolve(import.meta.dir, "..", "tiles", name);
  const source = JSON.parse(
    await readFile(join(dir, "manifest.json"), "utf8"),
  ) as SourceManifest;

  const agent = new AtpAgent({ service: requiredEnv("ATPROTO_PDS") });
  await agent.login({
    identifier: requiredEnv("ATPROTO_IDENTIFIER"),
    password: requiredEnv("ATPROTO_APP_PASSWORD"),
  });
  const repo = agent.session?.did;
  if (!repo) throw new Error("login returned no DID");

  // Upload every resource and swap its `file` for the blob the PDS returned.
  // `application/octet-stream` is what the spec recommends: some PDS versions
  // sniff the upload and refuse a record whose reference names a different
  // mimeType, while the entry's own `content-type` is what the browser is told.
  const resources: Record<string, Record<string, unknown>> = {};
  for (const [path, entry] of Object.entries(source.resources)) {
    const body = await readFile(join(dir, entry.file));
    const uploaded = await agent.uploadBlob(body, {
      encoding: "application/octet-stream",
    });
    // The agent hands back a `BlobRef` whose `ref` is a `CID` object; a record
    // needs the JSON form, which is the CID's string under `$link`.
    const blob: BlobRef = {
      $type: "blob",
      ref: { $link: String(uploaded.data.blob.ref) },
      mimeType: uploaded.data.blob.mimeType,
      size: uploaded.data.blob.size,
    };
    resources[path] = {
      src: blob,
      ...(entry["content-type"] ? { "content-type": entry["content-type"] } : {}),
    };
    console.log(`${path} <- ${entry.file} (${blob.size} B, ${blob.ref.$link})`);
  }

  const { resources: _sources, ...metadata } = source;
  const tile = { ...metadata, resources };
  const record = {
    $type: TILE_COLLECTION,
    cid: manifestCid(tile),
    tile,
    createdAt: new Date().toISOString(),
  };

  // `validate: false`: the PDS has no lexicon for this collection, so it would
  // otherwise refuse a record it cannot check.
  const created = await agent.com.atproto.repo.createRecord({
    repo,
    collection: TILE_COLLECTION,
    record,
    validate: false,
  });

  const uri = created.data.uri;
  console.log(`validation: ${created.data.validationStatus ?? "unknown"}`);
  console.log(`tile manifest cid: ${record.cid}`);
  console.log(`tile: ${uri}`);

  // Read the record back: what the PDS stores is what a loader will fetch, so
  // the paths it can resolve are worth printing rather than assuming.
  const stored = await agent.com.atproto.repo.getRecord({
    repo,
    collection: TILE_COLLECTION,
    rkey: uri.split("/").pop() ?? "",
  });
  const value = stored.data.value;
  const storedTile = value && typeof value === "object" && "tile" in value ? value.tile : undefined;
  const storedResources =
    storedTile && typeof storedTile === "object" && "resources" in storedTile
      ? storedTile.resources
      : undefined;
  console.log(
    `resources in the stored record: ${
      storedResources && typeof storedResources === "object"
        ? Object.keys(storedResources).join(", ")
        : "none"
    }`,
  );
}

await main();
