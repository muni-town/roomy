/**
 * Tests for the push dispatcher's per-recipient feature-flag gate.
 *
 * The dispatcher is global infrastructure that always processes every live
 * createMessage and computes fan-out. The `push-notifications` feature flag
 * is a per-recipient filter applied during evaluation (see push/evaluate.ts):
 * a recipient is skipped unless the flag is enabled for them (global or
 * per-DID assignment). The dispatcher process itself is always running.
 *
 * This test exercises the gate end-to-end through `evaluatePush`, proving
 * that a recipient with the flag gets a delivery and a recipient without it
 * is silently skipped — regardless of their push preference level or
 * subscription state.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { toAsyncDb } from "../db/syncAdapter.ts";
import type { DbLike } from "../db/types.ts";
import type { UserDid } from "@roomy-space/sdk";
import { evaluatePush } from "./evaluate.ts";
import { setUserDefault } from "../queries/pushPreferences.ts";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(THIS_DIR, "..", "db", "schema.sql");

const SPACE = "did:web:space.example";
const AUTHOR = "did:plc:alice";
const FLAGGED_READER = "did:plc:bob";
const UNFLAGGED_READER = "did:plc:eve";
const CHANNEL = "01CHANNEL00000000000000000";
const MESSAGE_ID = "01MSGFLAGTEST0000000000AA";

function freshDb(): DbLike {
  const db = new Database(":memory:");
  db.exec("pragma journal_mode = wal");
  db.exec("pragma synchronous = normal");
  db.exec("pragma foreign_keys = on");
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  db.exec("attach database ':memory:' as readstate");
  db.exec(
    "create table if not exists readstate_schema_version (id integer primary key check (id = 1), version text not null) strict",
  );
  db.exec(
    "create table if not exists readstate.push_subscriptions (user_did text not null, endpoint text not null, p256dh text not null, auth text not null, expiration_time integer, created_at integer not null default (unixepoch() * 1000), updated_at integer not null default (unixepoch() * 1000), primary key (user_did, endpoint)) strict",
  );
  db.exec(
    "create table if not exists readstate.push_user_default (user_did text primary key, level text not null check(level in ('silent','quiet','engaged','busy')) default 'engaged', updated_at integer not null default (unixepoch() * 1000)) strict",
  );
  db.exec(
    "create table if not exists readstate.push_preferences (user_did text not null, space_id text not null, level text not null check(level in ('silent','quiet','engaged','busy')), updated_at integer not null default (unixepoch() * 1000), primary key (user_did, space_id)) strict",
  );
  db.exec(
    "create table if not exists readstate.user_room_participation (user_did text not null, room_id text not null, last_message_at integer not null, updated_at integer not null default (unixepoch() * 1000), primary key (user_did, room_id)) strict",
  );
  db.exec(
    "create table if not exists readstate.notification_state (user_did text not null, room_id text not null, first_unseen_at integer, first_unseen_msg_id text, unseen_count integer not null default 0, notified integer not null default 0 check(notified in (0,1)), pushed_at integer, updated_at integer not null default (unixepoch() * 1000), primary key (user_did, room_id)) strict",
  );
  db.exec(
    "create table if not exists readstate.feature_flags (key text primary key, global_enabled integer not null default 0 check(global_enabled in (0, 1)), updated_at integer not null default (unixepoch() * 1000)) strict",
  );
  db.exec(
    "create table if not exists readstate.feature_flag_assignments (flag_key text not null, user_did text not null, updated_at integer not null default (unixepoch() * 1000), primary key (flag_key, user_did)) strict",
  );
  return toAsyncDb(db);
}

async function seedSpace(db: DbLike, spaceId = SPACE): Promise<void> {
  await db.run("insert into entities (id, stream_id) values (?, ?)", [spaceId, spaceId]);
  await db.run("insert into comp_space (entity) values (?)", [spaceId]);
}

async function seedUser(db: DbLike, did: string): Promise<void> {
  await db.run("insert or ignore into entities (id, stream_id) values (?, ?)", [did, did]);
  await db.run("insert or ignore into comp_user (did, handle) values (?, ?)", [did, null]);
}

async function seedChannel(db: DbLike, channelId: string, spaceId: string): Promise<void> {
  await db.run("insert into entities (id, stream_id) values (?, ?)", [channelId, spaceId]);
  await db.run(
    "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.channel', 'readwrite')",
    [channelId],
  );
}

async function addMember(db: DbLike, spaceId: string, did: string): Promise<void> {
  await db.run(
    "insert into edges (head, tail, label) values (?, ?, 'member')",
    [spaceId, did],
  );
}

async function addSubscription(db: DbLike, userDid: string): Promise<void> {
  await db.run(
    "insert into readstate.push_subscriptions (user_did, endpoint, p256dh, auth) values (?, ?, ?, ?)",
    [userDid, "https://push.example/" + userDid, "p256dh-key", "auth-key"],
  );
}

async function setFlagGlobal(db: DbLike, key: string, enabled: boolean): Promise<void> {
  await db.run(
    "insert into readstate.feature_flags (key, global_enabled, updated_at) values (?, ?, (unixepoch() * 1000)) on conflict(key) do update set global_enabled = excluded.global_enabled, updated_at = excluded.updated_at",
    [key, enabled ? 1 : 0],
  );
}

async function assignFlagToUser(db: DbLike, key: string, userDid: string): Promise<void> {
  await db.run(
    "insert into readstate.feature_flag_assignments (flag_key, user_did, updated_at) values (?, ?, (unixepoch() * 1000)) on conflict(flag_key, user_did) do nothing",
    [key, userDid],
  );
}

describe("push/evaluate — per-recipient feature-flag gate", () => {
  let db: DbLike;

  beforeEach(async () => {
    db = freshDb();
    await seedSpace(db);
    for (const did of [AUTHOR, FLAGGED_READER, UNFLAGGED_READER]) {
      await seedUser(db, did);
      await addMember(db, SPACE, did);
    }
    await seedChannel(db, CHANNEL, SPACE);
    await db.run("insert into comp_info (entity, name) values (?, ?)", [AUTHOR, "Alice"]);
    // Both readers are busy + have a device subscription.
    await setUserDefault(db, FLAGGED_READER, "busy");
    await setUserDefault(db, UNFLAGGED_READER, "busy");
    await addSubscription(db, FLAGGED_READER);
    await addSubscription(db, UNFLAGGED_READER);
  });

  test("recipient with the flag globally enabled gets a push", async () => {
    await setFlagGlobal(db, "push-notifications", true);
    const deliveries = await evaluatePush(db, {
      spaceId: SPACE,
      roomId: CHANNEL,
      messageId: MESSAGE_ID,
      authorDid: AUTHOR as UserDid,
      timestamp: 1_000_000,
    });
    const targets = deliveries.map((d) => d.userDid);
    expect(targets).toContain(FLAGGED_READER);
    expect(targets).toContain(UNFLAGGED_READER);
  });

  test("recipient without the flag (flag globally off) is skipped", async () => {
    // Flag is off globally; assign only to FLAGGED_READER.
    await assignFlagToUser(db, "push-notifications", FLAGGED_READER);
    const deliveries = await evaluatePush(db, {
      spaceId: SPACE,
      roomId: CHANNEL,
      messageId: MESSAGE_ID,
      authorDid: AUTHOR as UserDid,
      timestamp: 1_000_000,
    });
    const targets = deliveries.map((d) => d.userDid);
    expect(targets).toContain(FLAGGED_READER);
    expect(targets).not.toContain(UNFLAGGED_READER);
  });

  test("no pushes when the flag is off for everyone", async () => {
    // Flag globally off, no per-user assignments.
    const deliveries = await evaluatePush(db, {
      spaceId: SPACE,
      roomId: CHANNEL,
      messageId: MESSAGE_ID,
      authorDid: AUTHOR as UserDid,
      timestamp: 1_000_000,
    });
    expect(deliveries).toHaveLength(0);
  });
});