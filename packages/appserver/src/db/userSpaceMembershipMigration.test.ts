import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { encode } from "@atcute/cbor";
import { StreamDid, UserDid } from "@roomy-space/sdk";
import { closeDb, openDb, openReadStateDb } from "./db.ts";
import { toAsyncDb } from "./syncAdapter.ts";
import type { DbLike } from "./types.ts";
import {
  backfillUserThreadActivitySpaceDid,
  recoverUserSpaceMembership,
  reduceMembershipEvents,
  runPendingReadStateMigrationsWithRetry,
} from "./userSpaceMembershipMigration.ts";

const USER = UserDid.assert("did:plc:test-user");
const SPACE = StreamDid.assert("did:web:space.example");
const SPACE2 = StreamDid.assert("did:web:space2.example");

let db: DbLike;

beforeEach(() => {
  closeDb();
  db = openDb({ path: ":memory:" });
});

afterEach(() => {
  closeDb();
});

async function seedEvent(
  streamId: string,
  user: string,
  event: Record<string, unknown>,
): Promise<void> {
  const payload = encode(event);
  const idx = (
    await db
      .query("select coalesce(max(idx), -1) + 1 as n from stream_events where stream_id = ?")
      .get<{ n: number }>(streamId)
  )!.n;
  await db.run(
    "insert into stream_events (stream_id, idx, user, payload, signature) values (?, ?, ?, ?, x'')",
    streamId,
    idx,
    user,
    payload,
  );
}

async function readMembership(): Promise<Map<string, { state: string; source: string }>> {
  const readState = openReadStateDb();
  const rows = await readState
    .query("select user_did, space_did, state, source from user_space_membership")
    .all<{ user_did: string; space_did: string; state: string; source: string }>();
  const out = new Map<string, { state: string; source: string }>();
  for (const r of rows) out.set(`${r.user_did}\u0000${r.space_did}`, { state: r.state, source: r.source });
  return out;
}

describe("reduceMembershipEvents", () => {
  test("current join/leave events reduce by latest ULID", () => {
    const rows = [
      { rowid: 1, stream_id: SPACE, user: USER, payload: encode({ $type: "space.roomy.space.joinSpace.v0", id: "01AAAA0000000000000000000001" }) },
      { rowid: 2, stream_id: SPACE, user: USER, payload: encode({ $type: "space.roomy.space.leaveSpace.v0", id: "01AAAA0000000000000000000002" }) },
    ] as any;
    const out = reduceMembershipEvents(rows);
    expect(out.size).toBe(1);
    const ev = out.get(`${USER}\u0000${SPACE}`)!;
    expect(ev.state).toBe("left");
    expect(ev.eventId).toBe("01AAAA0000000000000000000002");
  });

  test("personal join/leave events use payload.spaceDid", () => {
    const rows = [
      { rowid: 1, stream_id: "did:web:personal.example", user: USER, payload: encode({ $type: "space.roomy.space.personal.joinSpace.v0", id: "01AAAA0000000000000000000001", spaceDid: SPACE }) },
      { rowid: 2, stream_id: "did:web:personal.example", user: USER, payload: encode({ $type: "space.roomy.space.personal.leaveSpace.v0", id: "01AAAA0000000000000000000002", spaceDid: SPACE }) },
    ] as any;
    const out = reduceMembershipEvents(rows);
    const ev = out.get(`${USER}\u0000${SPACE}`)!;
    expect(ev.state).toBe("left");
  });

  test("legacy variant events are recognised", () => {
    const rows = [
      { rowid: 1, stream_id: "did:web:personal.example", user: USER, payload: encode({ id: "01AAAA0000000000000000000001", variant: { $type: "space.roomy.stream.personal.joinSpace.v0", spaceDid: SPACE } }) },
    ] as any;
    const out = reduceMembershipEvents(rows);
    const ev = out.get(`${USER}\u0000${SPACE}`)!;
    expect(ev.state).toBe("joined");
  });

  test("non-membership events are ignored", () => {
    const rows = [
      { rowid: 1, stream_id: SPACE, user: USER, payload: encode({ $type: "space.roomy.message.createMessage.v0", id: "01AAAA0000000000000000000001" }) },
    ] as any;
    expect(reduceMembershipEvents(rows).size).toBe(0);
  });

  test("malformed payloads are skipped", () => {
    const rows = [
      { rowid: 1, stream_id: SPACE, user: USER, payload: new Uint8Array([1, 2, 3]) },
    ] as any;
    expect(reduceMembershipEvents(rows).size).toBe(0);
  });
});

describe("recoverUserSpaceMembership", () => {
  test("reduces the full event log into durable membership", async () => {
    // User joins SPACE, leaves, rejoins → joined.
    await seedEvent(SPACE, USER, { $type: "space.roomy.space.joinSpace.v0", id: "01AAAA0000000000000000000001" });
    await seedEvent(SPACE, USER, { $type: "space.roomy.space.leaveSpace.v0", id: "01AAAA0000000000000000000002" });
    await seedEvent(SPACE, USER, { $type: "space.roomy.space.joinSpace.v0", id: "01AAAA0000000000000000000003" });
    // User joins SPACE2 then leaves → left.
    await seedEvent(SPACE2, USER, { $type: "space.roomy.space.joinSpace.v0", id: "01AAAA0000000000000000000004" });
    await seedEvent(SPACE2, USER, { $type: "space.roomy.space.leaveSpace.v0", id: "01AAAA0000000000000000000005" });
    // A personal join for SPACE2 (older) must not override the current leave.
    await seedEvent("did:web:personal.example", USER, { $type: "space.roomy.space.personal.joinSpace.v0", id: "01AAAA0000000000000000000000", spaceDid: SPACE2 });

    await recoverUserSpaceMembership(db);

    const m = await readMembership();
    expect(m.get(`${USER}\u0000${SPACE}`)?.state).toBe("joined");
    expect(m.get(`${USER}\u0000${SPACE2}`)?.state).toBe("left");
  });

  test("is idempotent", async () => {
    await seedEvent(SPACE, USER, { $type: "space.roomy.space.joinSpace.v0", id: "01AAAA0000000000000000000001" });
    await recoverUserSpaceMembership(db);
    await recoverUserSpaceMembership(db);
    const m = await readMembership();
    expect(m.get(`${USER}\u0000${SPACE}`)?.state).toBe("joined");
  });
});

describe("runPendingReadStateMigrationsWithRetry", () => {
  test("retries then fails fast when a migration cannot complete", async () => {
    // A pending version with no registered task makes runPendingReadStateMigrations
    // throw. The retry helper must retry (attempts) times, then throw so the
    // boot path fails fast instead of serving with empty membership.
    const readState = openReadStateDb();
    // Stamp v6 complete so only the unregistered '999' version is pending.
    await readState.run(
      "update readstate_schema_migrations set completed_at = ? where version = '6'",
      Date.now(),
    );
    await readState.run(
      "insert or ignore into readstate_schema_migrations (version, completed_at) values ('999', null)",
    );

    let threw: Error | null = null;
    try {
      await runPendingReadStateMigrationsWithRetry(db, { attempts: 2, delayMs: 1 });
    } catch (err) {
      threw = err as Error;
    }
    expect(threw?.message).toMatch(/failed after 2 attempts/);

    // The pending row is still un-stamped (resumable — retried next boot).
    const row = await readState
      .query("select completed_at from readstate_schema_migrations where version = '999'")
      .get<{ completed_at: number | null }>();
    expect(row?.completed_at).toBeNull();
  });

  test("succeeds when the migration completes", async () => {
    // v6 is the only registered task; on a fresh :memory: DB it runs the
    // recovery (no events → no-op) and stamps completion.
    await runPendingReadStateMigrationsWithRetry(db, { attempts: 2, delayMs: 1 });
    const readState = openReadStateDb();
    const row = await readState
      .query("select completed_at from readstate_schema_migrations where version = '6'")
      .get<{ completed_at: number | null }>();
    expect(row?.completed_at).not.toBeNull();
  });

  test("is a no-op for structural-only schema v8 (space_order)", async () => {
    // Schema v8 (per-user space reordering) only adds the space_order table in
    // the DB worker — no async data task exists. A pending v8 row must be
    // stamped complete rather than throwing; otherwise the appserver crash-
    // loops at boot (regression for the staging 502s).
    //
    // Use a real in-process sqlite DB (via toAsyncDb) so the read-state
    // migration runner sees a concrete pending v8 row without the worker-pool
    // lifecycle that makes a :memory: pool's readstate handle transient.
    const raw = new Database(":memory:");
    raw.exec(`create table readstate_schema_migrations (
      version text primary key,
      completed_at integer
    ) strict`);
    raw.query(
      "insert or ignore into readstate_schema_migrations (version, completed_at) values ('8', null)",
    ).run();
    const readStateDb = toAsyncDb(raw);
    // The runner reads pending migrations from db.readState() (or db itself).
    const fakeDb = { readState: () => readStateDb } as unknown as DbLike;

    await expect(runPendingReadStateMigrationsWithRetry(fakeDb, { attempts: 2, delayMs: 1 }))
      .resolves.toBeUndefined();

    const row = await readStateDb
      .query("select completed_at from readstate_schema_migrations where version = '8'")
      .get<{ completed_at: number | null }>();
    expect(row?.completed_at).not.toBeNull();
    raw.close();
  });
});

describe("backfillUserThreadActivitySpaceDid", () => {
  test("backfills space_did from the global entity_space index", async () => {
    const readState = openReadStateDb();
    const global = db.global!();

    // Two threads the user engaged with, both missing space_did (legacy rows).
    const t1 = "01THREAD10000000000000000000";
    const t2 = "01THREAD20000000000000000000";
    for (const t of [t1, t2]) {
      await readState.run(
        "insert into user_thread_activity (user_did, thread_id, space_did, last_active_at) values (?, ?, '', ?)",
        [USER, t, Date.now()],
      );
    }

    // entity_space maps t1 → SPACE, t2 → SPACE2.
    await global.run("insert into entity_space (entity_id, space_did) values (?, ?)", [t1, SPACE]);
    await global.run("insert into entity_space (entity_id, space_did) values (?, ?)", [t2, SPACE2]);

    await backfillUserThreadActivitySpaceDid(db);

    const rows = await readState
      .query("select thread_id, space_did from user_thread_activity order by thread_id")
      .all<{ thread_id: string; space_did: string }>();
    expect(rows).toEqual([
      { thread_id: t1, space_did: SPACE },
      { thread_id: t2, space_did: SPACE2 },
    ]);
  });

  test("leaves unresolvable rows as ''", async () => {
    const readState = openReadStateDb();
    const t = "01THREAD30000000000000000000";
    await readState.run(
      "insert into user_thread_activity (user_did, thread_id, space_did, last_active_at) values (?, ?, '', ?)",
      [USER, t, Date.now()],
    );
    // No entity_space entry for t.

    await backfillUserThreadActivitySpaceDid(db);

    const row = await readState
      .query("select space_did from user_thread_activity where thread_id = ?")
      .get<{ space_did: string }>(t);
    expect(row?.space_did).toBe("");
  });
});
