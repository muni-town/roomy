import { StreamDid } from "@roomy-space/sdk";
import { createOp } from "@did-plc/lib";
import { Secp256k1Keypair } from "@atproto/crypto";
import type { DbLike } from "../db/types.ts";
import { storeStreamKey } from "./keys.ts";

const PLC_DIRECTORY = process.env.PLC_DIRECTORY_URL ?? "https://plc.directory";
const USE_DID_WEB = process.env.APPSERVER_USE_DID_WEB === "true";

/**
 * Create a new DID for a stream.
 *
 * Generates a fresh secp256k1 keypair per stream (matching Leaf's create_did).
 * In production (PLC_DIRECTORY_URL set and APPSERVER_USE_DID_WEB not true),
 * registers a DID PLC with the PLC directory using the per-stream key as both
 * rotation key and verification method (named "appserver"). The key is stored
 * in the events DB for later PLC operations (rotate service endpoint, update
 * handle).
 *
 * For local/dev environments, generates a did:web DID based on the appserver
 * URL host instead of hitting the PLC directory. The key is still stored for
 * consistency.
 */
export async function createStreamDid(
  appserverUrl: string,
  adminDid: string,
  db: DbLike,
): Promise<StreamDid> {
  const key = await Secp256k1Keypair.create({ exportable: true });

  if (USE_DID_WEB || !process.env.PLC_DIRECTORY_URL) {
    // did:web fallback for local/dev — no external registration needed
    const host = new URL(appserverUrl).host;
    const did = StreamDid.assert(`did:web:${host}`);
    await storeStreamKey(db, did, key, adminDid);
    return did;
  }

  const { op, did } = await createOp({
    signingKey: key.did(),
    handle: "",
    pds: appserverUrl,
    rotationKeys: [key.did()],
    signer: key,
  });

  const resp = await fetch(`${PLC_DIRECTORY}/${did}`, {
    method: "POST",
    body: JSON.stringify(op),
    headers: { "Content-Type": "application/json" },
  });
  if (!resp.ok) {
    throw new Error(`PLC directory error: ${resp.status}: ${await resp.text()}`);
  }

  await storeStreamKey(db, did, key, adminDid);

  return StreamDid.assert(did);
}
