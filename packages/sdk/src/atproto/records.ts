import type { Agent } from "@atproto/api";
import { StreamDid } from "../schema";

export interface StreamHandleConfig {
  collection: string;
}

/**
 * The JSON shape of an uploaded blob reference, as embedded in a record
 * (`BlobRef.toJSON()`). Named here because it is this module's return
 * contract, so consumers import it rather than re-deriving the shape.
 */
export interface BlobRefJson {
  $type: "blob";
  ref: { $link: string };
  mimeType: string;
  size: number;
}

/**
 * Every helper here writes to the caller's **own** repo, so none of them
 * sends an `atproto-proxy` header.
 *
 * A proxy header naming the caller's own `#atproto_pds` is a self-relay: it
 * tells the PDS to relay the request to the PDS it is already on. It is
 * redundant for a direct PDS session, and behind HappyView — which the web
 * client routes through — it is actively harmful. HappyView's forward-time
 * scope check maps *any* proxied request to `rpc:<nsid>?aud=<did>` and an
 * unproxied one to `repo:<collection>` (`src/xrpc/scope_check.rs`). The
 * `repo:` grant already covers these writes; the `rpc:` form does not, so the
 * header alone turns a permitted record write into a 403.
 */

/** Create a stream handle record linking a user's DID to a space. */
export async function createProfileSpaceRecord(
  agent: Agent,
  spaceId: StreamDid,
  config: StreamHandleConfig,
): Promise<void> {
  const resp = await agent.com.atproto.repo.putRecord({
    collection: config.collection,
    repo: agent.assertDid,
    rkey: "self",
    record: { $type: config.collection, id: spaceId },
  });
  if (!resp.success) throw new Error("Failed to create stream handle record");
}

/** Remove a stream handle record. */
export async function removeProfileSpaceRecord(
  agent: Agent,
  config: StreamHandleConfig,
): Promise<void> {
  const resp = await agent.com.atproto.repo.deleteRecord({
    collection: config.collection,
    repo: agent.assertDid,
    rkey: "self",
  });
  if (!resp.success) throw new Error("Failed to delete stream handle record");
}

/** Upload a blob to the user's PDS. */
export async function uploadBlob(
  agent: Agent,
  bytes: ArrayBuffer,
  opts?: { alt?: string; mimetype?: string },
): Promise<{ blob: BlobRefJson; uri: string }> {
  const resp = await agent.com.atproto.repo.uploadBlob(new Uint8Array(bytes));
  const blobRef = resp.data.blob;
  if (opts?.mimetype) blobRef.mimeType = opts.mimetype;

  // Create a record linking to the blob
  await agent.com.atproto.repo.putRecord({
    repo: agent.assertDid,
    collection: "space.roomy.upload.v0",
    rkey: `${Date.now()}`,
    record: {
      $type: "space.roomy.upload.v0",
      image: blobRef,
      alt: opts?.alt,
    },
  });

  return {
    blob: blobRef.toJSON() as BlobRefJson,
    uri: `atblob://${agent.assertDid}/${blobRef.ref}`,
  };
}
