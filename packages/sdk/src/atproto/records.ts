import type { Agent, BlobRef } from "@atproto/api";
import { StreamDid } from "../schema";

export interface StreamHandleConfig {
  collection: string;
}

export interface PersonalStreamRecordConfig {
  collection: string;
  schemaVersion: string;
}

/** Create a stream handle record linking a user's DID to a space. */
export async function createStreamHandleRecord(
  agent: Agent,
  spaceId: StreamDid,
  config: StreamHandleConfig
): Promise<void> {
  const resp = await agent.com.atproto.repo.putRecord({
    collection: config.collection,
    repo: agent.assertDid,
    rkey: "self",
    record: { id: spaceId },
  });
  if (!resp.success) throw new Error("Failed to create stream handle record");
}

/** Remove a stream handle record. */
export async function removeStreamHandleRecord(
  agent: Agent,
  config: StreamHandleConfig
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
  opts?: { alt?: string; mimetype?: string }
): Promise<{ blob: ReturnType<BlobRef["toJSON"]>; uri: string }> {
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
    blob: blobRef.toJSON(),
    uri: `atblob://${agent.assertDid}/${blobRef.ref}`,
  };
}

/** Get personal stream ID from PDS record. */
export async function getPersonalStreamId(
  agent: Agent,
  config: PersonalStreamRecordConfig
): Promise<StreamDid | undefined> {
  try {
    const resp = await agent.com.atproto.repo.getRecord({
      collection: config.collection,
      repo: agent.assertDid,
      rkey: config.schemaVersion,
    });
    const record = resp.data.value as { id?: string };
    return record.id ? StreamDid.assert(record.id) : undefined;
  } catch (e) {
    if ((e as { error?: string }).error === "RecordNotFound") {
      return undefined;
    }
    throw e;
  }
}

/** Save personal stream ID to PDS record. */
export async function savePersonalStreamId(
  agent: Agent,
  streamDid: StreamDid,
  config: PersonalStreamRecordConfig
): Promise<void> {
  const resp = await agent.com.atproto.repo.putRecord({
    collection: config.collection,
    repo: agent.assertDid,
    rkey: config.schemaVersion,
    record: { id: streamDid },
  });
  if (!resp.success) {
    throw new Error("Failed to save personal stream ID to PDS");
  }
}
