/**
 * Unit tests for StreamManager — sendEvents and createStream.
 *
 * Uses an in-memory SQLite DB (via openDb) so the events DB schema is
 * initialized. The StreamManager is constructed directly (not via the
 * singleton) so each test gets a fresh instance.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { newUlid, StreamDid, UserDid, parseEvent } from "@roomy-space/sdk";
import { Secp256k1Keypair } from "@atproto/crypto";
import { closeDb, openDb } from "../db/db.ts";
import { _resetHydrationInflight } from "../hydration/userHydration.ts";
import { _resetEmbedSweeper } from "../embed/sweeper.ts";
import { StreamManager } from "./StreamManager.ts";
import { storeStreamKey, getStreamSigningKey, listStreamOwners } from "./keys.ts";
import type { DbLike } from "../db/types.ts";

const ADMIN = UserDid.assert("did:plc:test-admin");
let db: DbLike;
let sm: StreamManager;

beforeEach(async () => {
  closeDb();
  _resetHydrationInflight();
  _resetEmbedSweeper();

  // Use a unique events DB path per test so events don't leak between tests.
  const testId = Math.random().toString(36).slice(2, 8);
  process.env.EVENTS_DB_PATH = `/tmp/roomy-events-${testId}.sqlite`;

  // In-memory singleton so the events DB schema is initialized.
  db = openDb({ path: ":memory:" });

  sm = new StreamManager(db, {
    appserverUrl: "http://test.example",
    // No profile fetcher — avoid HTTP calls to bsky.app.
    getProfiles: undefined,
  });
});

afterEach(() => {
  closeDb();
  delete process.env.EVENTS_DB_PATH;
});

function makeEvent(name: string) {
  const result = parseEvent({
    id: newUlid(),
    $type: "space.roomy.room.createRoom.v0",
    kind: "space.roomy.channel",
    name,
  });
  if (!result.success) throw new Error(result.error);
  return result.data;
}

// ─── sendEvents ─────────────────────────────────────────────────────────

describe("sendEvents", () => {
  test("idx assignment is monotonic and correct across multiple calls", async () => {
    const stream = StreamDid.assert("did:web:monotonic-test.example");

    await sm.sendEvents(stream, [makeEvent("a"), makeEvent("b")], ADMIN);
    await sm.sendEvents(stream, [makeEvent("c")], ADMIN);

    const rows = await db
      .query<{ idx: number }>(
        "select idx from events.stream_events where stream_id = ? order by idx",
      )
      .all(stream);

    expect(rows).toHaveLength(3);
    expect(rows[0]!.idx).toBe(0);
    expect(rows[1]!.idx).toBe(1);
    expect(rows[2]!.idx).toBe(2);
  });

  test("concurrent sendEvents for the same stream do NOT collide", async () => {
    const stream = StreamDid.assert("did:web:concurrent-test.example");
    const N = 5; // concurrent callers
    const M = 3; // events per caller

    const eventsByCaller = Array.from({ length: N }, () =>
      Array.from({ length: M }, () => makeEvent("concurrent")),
    );

    await Promise.all(
      eventsByCaller.map((events) => sm.sendEvents(stream, events, ADMIN)),
    );

    const rows = await db
      .query<{ idx: number }>(
        "select idx from events.stream_events where stream_id = ? order by idx",
      )
      .all(stream);

    // Expect N * M rows with unique contiguous idx
    expect(rows).toHaveLength(N * M);
    for (let i = 0; i < rows.length; i++) {
      expect(rows[i]!.idx).toBe(i);
    }
  });

  test("CBOR roundtrip — decoded event equals input event", async () => {
    const stream = StreamDid.assert("did:web:roundtrip-test.example");
    const event = makeEvent("roundtrip-test");

    await sm.sendEvents(stream, [event], ADMIN);

    const row = await db
      .query<{ payload: Uint8Array }>(
        "select payload from events.stream_events where stream_id = ? and idx = 0",
      )
      .get(stream);

    expect(row).not.toBeNull();
    expect(row!.payload).toBeInstanceOf(Uint8Array);

    const { decode } = await import("@atcute/cbor");
    const decoded = decode(row!.payload);

    expect(decoded).toEqual(event);
  });
});

// ─── createStream ───────────────────────────────────────────────────────

describe("createStream", () => {
  test("writes the addAdmin event and the entities row", async () => {
    const streamDid = await sm.createStream(ADMIN);

    // Entities row exists
    const entityRow = await db
      .query<{ id: string; stream_id: string }>(
        "select id, stream_id from entities where id = ?",
      )
      .get(streamDid);
    expect(entityRow).not.toBeNull();
    expect(entityRow!.id).toBe(streamDid);
    expect(entityRow!.stream_id).toBe(streamDid);

    // addAdmin event exists in events DB
    const eventRow = await db
      .query<{ idx: number; user: string }>(
        "select idx, user from events.stream_events where stream_id = ? order by idx",
      )
      .all(streamDid);
    expect(eventRow.length).toBeGreaterThanOrEqual(1);
    expect(eventRow[0]!.user).toBe(ADMIN);
  });

  test("failure cleanup — if sendEvents throws, entities row is removed", async () => {
    // Create a minimal DbLike mock that only supports the operations
    // createStream actually calls: run (for entities insert + key storage)
    // and transaction (which we make throw).
    let insertedEntity: string | null = null;
    const mockDb: DbLike = {
      query: () => {
        throw new Error("query not expected in this test");
      },
      prepare: async () => {
        throw new Error("prepare not expected in this test");
      },
      exec: async () => {
        throw new Error("exec not expected in this test");
      },
      run: async (sql: string, ...params: unknown[]) => {
        // Capture the entities insert so we can verify cleanup
        if (sql.includes("insert into entities")) {
          insertedEntity = params[0] as string;
        }
        // Track delete cleanup
        if (sql.includes("delete from entities")) {
          insertedEntity = null;
        }
        return { changes: 1 };
      },
      transaction: async <T>(): Promise<T> => {
        throw new Error("simulated sendEvents failure");
      },
      close: async () => {},
    };

    const failingSm = new StreamManager(mockDb, {
      appserverUrl: "http://test.example",
      getProfiles: undefined,
    });

    await expect(failingSm.createStream(ADMIN)).rejects.toThrow(
      "simulated sendEvents failure",
    );

    // The entities row should have been cleaned up (deleted)
    expect(insertedEntity).toBeNull();
  });
});

// ─── key storage roundtrip ──────────────────────────────────────────────

describe("key storage roundtrip", () => {
  test("storeStreamKey + getStreamSigningKey roundtrip preserves signing capability", async () => {
    const did = "did:plc:test-key-roundtrip";
    const owner = "did:plc:test-owner";
    const key = await Secp256k1Keypair.create({ exportable: true });

    await storeStreamKey(db, did, key, owner);

    const recovered = await getStreamSigningKey(db, did);
    expect(recovered).not.toBeNull();

    // Both keypairs should produce the same DID
    expect(recovered!.did()).toBe(key.did());

    // Both keypairs should sign and verify the same data
    const msg = new TextEncoder().encode("test-message");
    const sig = await key.sign(msg);
    const recoveredSig = await recovered!.sign(msg);
    expect(sig).toEqual(recoveredSig);
  });

  test("getStreamSigningKey returns null for unknown DID", async () => {
    const result = await getStreamSigningKey(db, "did:plc:nonexistent");
    expect(result).toBeNull();
  });

  test("listStreamOwners returns stored owners", async () => {
    const did = "did:plc:test-owners";
    const key = await Secp256k1Keypair.create({ exportable: true });

    await storeStreamKey(db, did, key, "did:plc:owner-1");
    await storeStreamKey(db, did, key, "did:plc:owner-2");

    const owners = await listStreamOwners(db, did);
    expect(owners).toContain("did:plc:owner-1");
    expect(owners).toContain("did:plc:owner-2");
  });
});
