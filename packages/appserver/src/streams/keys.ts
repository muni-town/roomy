import { Secp256k1Keypair } from "@atproto/crypto";
import type { DbLike } from "../db/types.ts";

/**
 * Store a per-stream DID signing key in the events DB.
 *
 * Inserts into dids, did_keys (k256_key as raw private key bytes), and
 * did_owners. Uses INSERT OR IGNORE so re-runs are idempotent.
 *
 * The k256_key blob stores the raw 32-byte secp256k1 private key.
 * Secp256k1Keypair.export() returns these raw bytes; Secp256k1Keypair.import()
 * accepts them as a Uint8Array.
 */
export async function storeStreamKey(
  db: DbLike,
  did: string,
  key: Secp256k1Keypair,
  owner: string,
): Promise<void> {
  const rawKey = await key.export();

  await db.run("insert or ignore into events.dids (did) values (?)", did);
  await db.run(
    "insert or ignore into events.did_keys (did, p256_key, k256_key) values (?, ?, ?)",
    did,
    null,
    rawKey,
  );
  await db.run(
    "insert or ignore into events.did_owners (did, owner) values (?, ?)",
    did,
    owner,
  );
}

/**
 * Retrieve a per-stream signing key from the events DB.
 *
 * Reads the k256_key blob from did_keys and reconstructs a
 * Secp256k1Keypair. Returns null if no row exists for the given DID.
 */
export async function getStreamSigningKey(
  db: DbLike,
  did: string,
): Promise<Secp256k1Keypair | null> {
  const row = await db
    .query("select k256_key from events.did_keys where did = ?")
    .get<{ k256_key: Uint8Array | null }>(did);

  if (!row || !row.k256_key) return null;

  return Secp256k1Keypair.import(row.k256_key, { exportable: true });
}

/**
 * List all owners of a stream DID from the events DB.
 */
export async function listStreamOwners(
  db: DbLike,
  did: string,
): Promise<string[]> {
  const rows = await db
    .query("select owner from events.did_owners where did = ?")
    .all<{ owner: string }>(did);

  return rows.map((r) => r.owner);
}
