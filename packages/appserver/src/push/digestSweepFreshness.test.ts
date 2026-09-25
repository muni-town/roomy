/**
 * Digest sweep freshness gate.
 *
 * The digest-side half of the push replay problem. `selectDueDigests` returns
 * rows whose 1h timer elapsed; the sweep runs on every idle wake (60s poll) and
 * fires one digest push per row. Rows are only deleted when the user reopens
 * the room, so a backlog that accumulated across a restart — or was seeded by a
 * replay — fires the moment the process comes back, up to 64 pushes/minute of
 * hours-old messages.
 *
 * The sweep is driven directly (no loop, no wall-clock wait). What these tests
 * must pin is the age ceiling itself: `selectDueDigests` returning a row is
 * correct on its own, so asserting on the query would not catch a missing
 * ceiling.
 */

import { describe, expect, test, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { _runDigestSweep, _resetPushDispatcher, pushDispatcherStats } from "./dispatcher.ts";
import { PUSH_MAX_DIGEST_AGE_MS } from "./freshness.ts";
import type { DbLike } from "../db/types.ts";

const USER = "did:plc:sweep-user";

// Lifetime counters are module state; reset so each case reads its own sweep.
afterEach(() => {
  _resetPushDispatcher();
});

/** Minimal read-state DB carrying just what the sweep touches. */
function freshDb(): DbLike {
  const raw = new Database(":memory:");
  raw.exec(`create table notification_state (
    user_did text not null,
    room_id text not null,
    first_unseen_at integer,
    first_unseen_msg_id text,
    unseen_count integer not null default 0,
    notified integer not null default 0,
    pushed_at integer,
    updated_at integer not null default (unixepoch() * 1000),
    primary key (user_did, room_id)
  ) strict;`);
  raw.exec(`create table push_subscriptions (
    user_did text not null, endpoint text not null, p256dh text not null,
    auth text not null, expiration_time integer,
    created_at integer not null default (unixepoch() * 1000),
    updated_at integer not null default (unixepoch() * 1000),
    primary key (user_did, endpoint)
  ) strict;`);
  return raw as unknown as DbLike;
}

async function seedPending(db: DbLike, roomId: string, firstUnseenAt: number): Promise<void> {
  await db.run(
    `insert into notification_state
       (user_did, room_id, first_unseen_at, first_unseen_msg_id, unseen_count, notified)
     values (?, ?, ?, ?, 3, 0)`,
    USER,
    roomId,
    firstUnseenAt,
    "01SWEEPMESSAGE000000000000",
  );
}

async function stateOf(db: DbLike, roomId: string) {
  return db
    .query("select notified from notification_state where user_did = ? and room_id = ?")
    .get<{ notified: number }>(USER, roomId);
}

describe("push/dispatcher — digest sweep freshness", () => {
  test("a stale pending batch is dropped, never fired", async () => {
    const db = freshDb();
    const room = "01STALEROOM00000000000000";
    // Stale batch: it started long before the process came back, so its 1h
    // timer is long past and `selectDueDigests` considers it due.
    await seedPending(db, room, Date.now() - PUSH_MAX_DIGEST_AGE_MS - 60_000);

    await _runDigestSweep(db);

    // Dropped — not delivered (no subscription exists, so a delivery would
    // also be invisible; the row state is the real signal), and not left
    // pending for the next 60s poll to re-examine. With no age ceiling the row
    // survives (the sweep only ever marks it notified when a subscription
    // exists).
    expect(await stateOf(db, room)).toBeNull();
    expect(pushDispatcherStats().digestsFired).toBe(0);
  });

  test("a fresh overdue batch is left for delivery, not dropped", async () => {
    const db = freshDb();
    const room = "01FRESHROOM00000000000000";
    // Overdue (1h timer elapsed) but still within the age ceiling: a genuine
    // "you were away" batch. The ceiling must not sweep this away.
    await seedPending(db, room, Date.now() - PUSH_MAX_DIGEST_AGE_MS + 60_000);

    await _runDigestSweep(db);

    // No subscription → nothing delivered, but the row is marked notified
    // rather than deleted, the normal "fired, do not re-fire" behaviour.
    // (Dropping it instead is the stale path above.)
    expect((await stateOf(db, room))?.notified).toBe(1);
  });

  test("no pending batch is a no-op", async () => {
    const db = freshDb();
    await _runDigestSweep(db);
    expect(pushDispatcherStats().digestsFired).toBe(0);
  });
});
