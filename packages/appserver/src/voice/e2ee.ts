/**
 * Per-call E2EE keys.
 *
 * Every call gets a key before its first token is minted, and the key is
 * shredded when the call ends. The key is deliberately NOT an event: the event
 * store is replayed, replicated, and readable by anyone who can read the
 * stream, so a key written there would be a key published. It lives in the
 * read-state DB, keyed by callId, and only the appserver can read it back.
 *
 * Shredding is what makes the end of a call mean something: recordings or
 * captured media from that call are unreadable once the key is gone, and a
 * replayed `callEnded` is idempotent because deleting an absent row is a
 * no-op.
 */

import { randomBytes } from "node:crypto";
import { openReadStateDb } from "../db/db.ts";
import { log } from "../log.ts";

/** 256-bit key, base64. LiveKit's ExternalE2EEKeyProvider takes it verbatim. */
const KEY_BYTES = 32;

/**
 * The call's E2EE key, creating it on first use.
 *
 * Idempotent by construction: the insert is `on conflict do nothing`, so two
 * first-joins racing produce one key and both callers read back the winner.
 */
export async function ensureCallE2eeKey(callId: string): Promise<string> {
  const db = openReadStateDb();
  const existing = await readKey(db, callId);
  if (existing) return existing;

  const key = randomBytes(KEY_BYTES).toString("base64");
  try {
    await db.run(
      `insert into voice_call_keys (call_id, key, created_at)
       values (?, ?, ?)
       on conflict (call_id) do nothing`,
      callId,
      key,
      Date.now(),
    );
  } catch (err) {
    log.error(
      `[voice] E2EE key insert failed for ${callId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return key;
  }
  // Read back rather than returning the value just generated: a concurrent
  // first join may have won the insert.
  return (await readKey(db, callId)) ?? key;
}

/** Shred the call's key. Idempotent — an absent key is already shredded. */
export async function shredCallE2eeKey(callId: string): Promise<void> {
  try {
    await openReadStateDb().run(
      `delete from voice_call_keys where call_id = ?`,
      callId,
    );
  } catch (err) {
    // Not fatal to the call's ending, and the reconciler's retry path will
    // come back through here for a call it still believes is live.
    log.error(
      `[voice] E2EE key shred failed for ${callId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

async function readKey(
  db: ReturnType<typeof openReadStateDb>,
  callId: string,
): Promise<string | null> {
  try {
    const row = await db
      .query(`select key from voice_call_keys where call_id = ?`)
      .get<{ key: string }>(callId);
    return row?.key ?? null;
  } catch {
    return null;
  }
}
