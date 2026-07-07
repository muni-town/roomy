/**
 * Benchmark: run key read queries against a materialized in-memory DB.
 *
 * Materializes the large space (did:plc:4moccs43r5v2xzkynae3xk2u), then
 * runs each query 5×, reports min/avg/max timing and EXPLAIN QUERY PLAN.
 *
 * Usage:
 *   bun run packages/appserver/scripts/bench-queries.ts
 *
 * Environment:
 *   EVENTS_DB_PATH  — path to the events SQLite DB (default: data/roomy-events.sqlite)
 */

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { decode } from "@atcute/cbor";
import type { DecodedStreamEvent, Event, StreamDid, StreamIndex, UserDid } from "@roomy-space/sdk";
import { applyBatch } from "../src/materialization/applyBatch.ts";
import { toAsyncDb } from "../src/db/syncAdapter.ts";
import type { DbLike } from "../src/db/types.ts";

const dummyResponse = new Response("[]", {
  status: 200,
  headers: { "Content-Type": "application/json" },
});
globalThis.fetch = async () => dummyResponse;

// ── Paths ──────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const SCHEMA_PATH = join(__dirname, "..", "src", "db", "schema.sql");
const READSTATE_SCHEMA_PATH = join(__dirname, "..", "src", "db", "readStateSchema.sql");
const SCHEMA_VERSION = "10-appserver.4";
const READSTATE_SCHEMA_VERSION = "2";

// ── Helpers ────────────────────────────────────────────────────────────────

function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  if (ms >= 1) return `${ms.toFixed(2)}ms`;
  if (ms >= 0.001) return `${(ms * 1000).toFixed(2)}µs`;
  return `${(ms * 1_000_000).toFixed(0)}ns`;
}

function formatRate(count: number, elapsedMs: number): string {
  return `${(count / (elapsedMs / 1000)).toFixed(0)} evt/s`;
}

// ── Timing helpers ─────────────────────────────────────────────────────────

interface Timing {
  min: number;
  max: number;
  avg: number;
  runs: number[];
}

function computeTimings(runs: number[]): Timing {
  const min = Math.min(...runs);
  const max = Math.max(...runs);
  const avg = runs.reduce((a, b) => a + b, 0) / runs.length;
  return { min, max, avg, runs };
}

function formatTiming(t: Timing): string {
  return `min=${formatMs(t.min)}  avg=${formatMs(t.avg)}  max=${formatMs(t.max)}  (${t.runs.length} runs)`;
}

// ── Benchmark runner ───────────────────────────────────────────────────────

async function benchQuery(
  label: string,
  db: DbLike,
  sql: string,
  params: unknown[],
  runs = 5,
): Promise<Timing> {
  const timings: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = Bun.nanoseconds();
    await db.query(sql).all(...params);
    const t1 = Bun.nanoseconds();
    timings.push((t1 - t0) / 1_000_000);
  }
  return computeTimings(timings);
}

function explainQueryPlan(db: Database, sql: string, params: unknown[]): string {
  const rows = db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{
    id: number;
    parent: number;
    notused: number;
    detail: string;
  }>;
  return rows.map((r) => `  ${"  ".repeat(r.parent)}${r.detail}`).join("\n");
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const eventsDbPath = process.env.EVENTS_DB_PATH ?? join(DATA_DIR, "roomy-events.sqlite");
  const spaceDid = "did:plc:4moccs43r5v2xzkynae3xk2u";

  console.log("═══ Query Performance Benchmark ═══\n");

  // ── Open events DB ──────────────────────────────────────────────────────
  console.log("── Opening events DB ────────────────");
  const eventsDb = new Database(eventsDbPath);
  eventsDb.exec("pragma synchronous = normal");

  // ── Read events ─────────────────────────────────────────────────────────
  console.log(`  Reading events for space: ${spaceDid}`);
  const t0 = Bun.nanoseconds();
  const rawEvents = eventsDb
    .query("SELECT idx, user, payload FROM stream_events WHERE stream_id = ? ORDER BY idx")
    .all(spaceDid) as Array<{ idx: number; user: string; payload: Uint8Array }>;
  const t1 = Bun.nanoseconds();
  console.log(`  Read ${rawEvents.length} events from DB: ${formatMs((t1 - t0) / 1_000_000)}`);

  // ── Decode events ───────────────────────────────────────────────────────
  const t2 = Bun.nanoseconds();
  const decodedEvents: DecodedStreamEvent[] = rawEvents.map(
    (e): DecodedStreamEvent => {
      const event = decode(e.payload) as Event;
      return {
        idx: e.idx as StreamIndex,
        event,
        user: e.user as UserDid,
      };
    },
  );
  const t3 = Bun.nanoseconds();
  console.log(`  Decoded ${decodedEvents.length} events (CBOR): ${formatMs((t3 - t2) / 1_000_000)}`);
  // ── Create fresh materialization DB ──────────────────────────────────────
  console.log(`\n── Creating materialization DB ────────`);
  const t4 = Bun.nanoseconds();
  const db = new Database(":memory:");
  db.exec("pragma journal_mode = wal");
  db.exec("pragma synchronous = normal");
  db.exec("pragma foreign_keys = on");
  const schemaSql = readFileSync(SCHEMA_PATH, "utf8");
  db.exec(schemaSql);
  // Attach readstate DB and apply schema
  db.exec("attach database ':memory:' as readstate");
  db.exec("create table if not exists readstate_schema_version (id integer primary key check (id = 1), version text not null) strict");
  db.exec("create table if not exists readstate.read_positions (user_did text not null, room_id text not null, seen_up_to text not null, unread_count integer not null default 0, updated_at integer not null default (unixepoch() * 1000), primary key (user_did, room_id)) strict");
  db.exec("create table if not exists readstate.user_thread_activity (user_did text not null, thread_id text not null, last_active_at integer not null, updated_at integer not null default (unixepoch() * 1000), primary key (user_did, thread_id)) strict");
  const t5 = Bun.nanoseconds();
  db.run("insert or replace into readstate_schema_version (id, version) values (1, ?)", [READSTATE_SCHEMA_VERSION]);
  console.log(`  Created materialization DB + readstate: ${formatMs((t5 - t4) / 1_000_000)}`);
  const asyncDb: DbLike = toAsyncDb(db);

  // ── Materialize ─────────────────────────────────────────────────────────
  console.log(`\n── Materializing space ────────────────`);
  const t6 = Bun.nanoseconds();
  const stats = await applyBatch(asyncDb, spaceDid as StreamDid, decodedEvents, {
    isBackfill: true,
  });
  const t7 = Bun.nanoseconds();
  const materializeMs = (t7 - t6) / 1_000_000;
  console.log(`  Applied: ${stats.applied}, errors: ${stats.applyErrors + stats.materializerErrors}`);
  console.log(`  Materialize time: ${formatMs(materializeMs)} (${formatRate(decodedEvents.length, materializeMs)})`);

  // ── DB state summary ────────────────────────────────────────────────────
  const entityCount = db.query("SELECT COUNT(*) as c FROM entities").get() as { c: number };
  const edgeCount = db.query("SELECT COUNT(*) as c FROM edges").get() as { c: number };
  const contentCount = db.query("SELECT COUNT(*) as c FROM comp_content").get() as { c: number };
  const roomCount = db.query("SELECT COUNT(*) as c FROM comp_room").get() as { c: number };
  const activityCount = db.query("SELECT COUNT(*) as c FROM activity_item").get() as { c: number };
  const reactionCount = db.query("SELECT COUNT(*) as c FROM comp_reaction").get() as { c: number };
  const embedImageCount = db.query("SELECT COUNT(*) as c FROM comp_embed_image").get() as { c: number };
  const embedLinkCount = db.query("SELECT COUNT(*) as c FROM comp_embed_link").get() as { c: number };
  const infoCount = db.query("SELECT COUNT(*) as c FROM comp_info").get() as { c: number };
  console.log(`\n  DB state:`);
  console.log(`    entities:       ${entityCount.c}`);
  console.log(`    edges:          ${edgeCount.c}`);
  console.log(`    comp_content:   ${contentCount.c}`);
  console.log(`    comp_room:      ${roomCount.c}`);
  console.log(`    activity_item:  ${activityCount.c}`);
  console.log(`    comp_reaction:  ${reactionCount.c}`);
  console.log(`    comp_embed_img: ${embedImageCount.c}`);
  console.log(`    comp_embed_link:${embedLinkCount.c}`);
  console.log(`    comp_info:      ${infoCount.c}`);

  // ── Discover query parameters from materialized data ────────────────────
  console.log(`\n── Discovering query parameters ───────`);

  // Find a room with messages
  const sampleRoom = db.query(
    `SELECT e.room, COUNT(*) as cnt FROM entities e
     JOIN comp_content cc ON cc.entity = e.id
     WHERE e.room IS NOT NULL
     GROUP BY e.room ORDER BY cnt DESC LIMIT 1`
  ).get() as { room: string; cnt: number } | null;
  console.log(`  Sample room: ${sampleRoom?.room ?? "N/A"} (${sampleRoom?.cnt ?? 0} messages)`);

  // Find a space with activity items
  const sampleSpace = db.query(
    `SELECT space_id, COUNT(*) as cnt FROM activity_item GROUP BY space_id ORDER BY cnt DESC LIMIT 1`
  ).get() as { space_id: string; cnt: number } | null;
  console.log(`  Sample space: ${sampleSpace?.space_id ?? "N/A"} (${sampleSpace?.cnt ?? 0} activity items)`);

  // Find a user with joinedSpace edges
  const sampleUser = db.query(
    `SELECT je.tail as user_did, COUNT(*) as cnt
     FROM edges je
     WHERE je.label = 'joinedSpace'
     GROUP BY je.tail ORDER BY cnt DESC LIMIT 1`
  ).get() as { user_did: string; cnt: number } | null;
  console.log(`  Sample user: ${sampleUser?.user_did ?? "N/A"} (${sampleUser?.cnt ?? 0} joined spaces)`);

  // Find a personal stream (head of joinedSpace edges)
  const samplePersonalStream = db.query(
    `SELECT je.head as personal_stream, COUNT(*) as cnt
     FROM edges je
     WHERE je.label = 'joinedSpace'
     GROUP BY je.head ORDER BY cnt DESC LIMIT 1`
  ).get() as { personal_stream: string; cnt: number } | null;
  console.log(`  Sample personal stream: ${samplePersonalStream?.personal_stream ?? "N/A"} (${samplePersonalStream?.cnt ?? 0} joined spaces)`);

  // Find a channel with threads
  const sampleChannel = db.query(
    `SELECT link_e.head as channel_id, COUNT(*) as cnt
     FROM edges link_e
     JOIN comp_room cr ON cr.entity = link_e.tail
     WHERE link_e.label = 'link'
       AND cr.label = 'space.roomy.thread'
       AND coalesce(json_extract(link_e.payload, '$.canonical_parent'), 0) = 1
     GROUP BY link_e.head ORDER BY cnt DESC LIMIT 1`
  ).get() as { channel_id: string; cnt: number } | null;
  console.log(`  Sample channel: ${sampleChannel?.channel_id ?? "N/A"} (${sampleChannel?.cnt ?? 0} threads)`);

  // Find threads in the space
  const threadCount = db.query(
    `SELECT COUNT(*) as c FROM comp_room WHERE label = 'space.roomy.thread' AND coalesce(deleted, 0) = 0`
  ).get() as { c: number };
  console.log(`  Threads in space: ${threadCount.c}`);

  // ── Parameters for queries ─────────────────────────────────────────────
  const roomId = sampleRoom?.room ?? "";
  const spaceId = sampleSpace?.space_id ?? spaceDid;
  const userDid = sampleUser?.user_did ?? "";
  const personalStreamDid = samplePersonalStream?.personal_stream ?? "";
  const channelId = sampleChannel?.channel_id ?? "";

  // ── BEFORE: Benchmark queries ──────────────────────────────────────────
  console.log(`\n═══ BEFORE OPTIMIZATIONS ═══\n`);

  // ── 1. selectMessages (room scope) ──────────────────────────────────────
  console.log(`── Query 1: selectMessages (room scope) ──`);
  const msgSql = `
    select
      e.id as id,
      e.sort_idx as sort_idx,
      e.room as room,
      cc.mime_type as mime_type,
      cc.data as data,
      cc.timestamp as timestamp,
      author_e.tail as author_did,
      author_info.name as author_name,
      author_info.avatar as author_avatar,
      author_user.handle as author_handle,
      reply_e.tail as reply_to,
      forward_e.tail as forward_target,
      forward_target_entity.room as forward_target_room,
      forward_target_room_info.name as forward_target_room_name
    from entities e
    left join comp_content cc on cc.entity = e.id
    left join edges author_e
      on author_e.head = e.id and author_e.label = 'author'
    left join comp_info author_info on author_info.entity = author_e.tail
    left join comp_user author_user on author_user.did = author_e.tail
    left join edges reply_e
      on reply_e.head = e.id and reply_e.label = 'reply'
    left join edges forward_e
      on forward_e.head = e.id and forward_e.label = 'forward'
    left join entities forward_target_entity
      on forward_target_entity.id = forward_e.tail
    left join comp_info forward_target_room_info
      on forward_target_room_info.entity = forward_target_entity.room
    where e.room = ?1
      and (cc.entity is not null or forward_e.tail is not null)
    order by coalesce(e.sort_idx, e.id) desc
    limit 50
  `;
  const msgParams = [roomId];

  console.log(`\n  EXPLAIN QUERY PLAN:`);
  console.log(explainQueryPlan(db, msgSql, msgParams));

  const msgTiming = await benchQuery("selectMessages", asyncDb, msgSql, msgParams);
  console.log(`\n  Timing: ${formatTiming(msgTiming)}`);

  // ── 2. activityFeed ─────────────────────────────────────────────────────
  console.log(`\n── Query 2: activityFeed ────────────────`);
  const feedSql = `
    select
      ai.room_id, ai.space_id, ai.is_thread,
      ai.parent_channel_id, ai.parent_channel_name,
      ai.last_activity_at, ai.recent_message_ids,
      ai.room_name, ai.space_name, ai.space_avatar
    from activity_item ai
    left join comp_room cr on cr.entity = ai.room_id
    where ai.space_id in (select tail from edges where head = ? and label = 'joinedSpace')
      and (cr.deleted is null or cr.deleted = 0)
    order by ai.last_activity_at desc, ai.room_id desc
    limit 50
  `;
  const feedParams = [personalStreamDid];

  console.log(`\n  EXPLAIN QUERY PLAN:`);
  console.log(explainQueryPlan(db, feedSql, feedParams));

  const feedTiming = await benchQuery("activityFeed", asyncDb, feedSql, feedParams);
  console.log(`\n  Timing: ${formatTiming(feedTiming)}`);

  // ── 3. threadActivity (space scope) ─────────────────────────────────────
  console.log(`\n── Query 3a: threadActivity (space scope) ──`);
  const threadSpaceSql = `
    select e.id as id, ci.name as name
    from entities e
    join comp_room cr on cr.entity = e.id
    left join comp_info ci on ci.entity = e.id
    where e.stream_id = ?
      and cr.label = 'space.roomy.thread'
      and coalesce(cr.deleted, 0) = 0
  `;
  const threadSpaceParams = [spaceId];

  console.log(`\n  EXPLAIN QUERY PLAN:`);
  console.log(explainQueryPlan(db, threadSpaceSql, threadSpaceParams));

  const threadSpaceTiming = await benchQuery("threadActivity(space)", asyncDb, threadSpaceSql, threadSpaceParams);
  console.log(`\n  Timing: ${formatTiming(threadSpaceTiming)}`);

  // ── 3b. threadActivity (channel scope) ──────────────────────────────────
  if (channelId) {
    console.log(`\n── Query 3b: threadActivity (channel scope) ──`);
    const threadChannelSql = `
      select e.id as id, ci.name as name
      from entities e
      join comp_room cr on cr.entity = e.id
      left join comp_info ci on ci.entity = e.id
      join edges link_e on link_e.tail = e.id
        and link_e.label = 'link'
        and coalesce(json_extract(link_e.payload, '$.canonical_parent'), 0) = 1
      where cr.label = 'space.roomy.thread'
        and coalesce(cr.deleted, 0) = 0
        and link_e.head = ?
    `;
    const threadChannelParams = [channelId];

    console.log(`\n  EXPLAIN QUERY PLAN:`);
    console.log(explainQueryPlan(db, threadChannelSql, threadChannelParams));

    const threadChannelTiming = await benchQuery("threadActivity(channel)", asyncDb, threadChannelSql, threadChannelParams);
    console.log(`\n  Timing: ${formatTiming(threadChannelTiming)}`);
  }

  // ── 3c. threadActivity latest timestamps ───────────────────────────────
  // First get thread IDs
  const threadIds = db.query(
    `SELECT e.id FROM entities e
     JOIN comp_room cr ON cr.entity = e.id
     WHERE e.stream_id = ? AND cr.label = 'space.roomy.thread' AND coalesce(cr.deleted, 0) = 0
     LIMIT 20`
  ).all(spaceId) as Array<{ id: string }>;
  const tidList = threadIds.map((t) => t.id);
  const tidPh = tidList.map(() => "?").join(",");

  if (tidList.length > 0) {
    console.log(`\n── Query 3c: threadActivity (latest timestamps) ──`);
    const latestTsSql = `
      select e.room as room,
             max(coalesce(cc.timestamp, fwd_cc.timestamp)) as ts
      from entities e
      left join comp_content cc on cc.entity = e.id
      left join edges forward_e
        on forward_e.head = e.id and forward_e.label = 'forward'
      left join comp_content fwd_cc on fwd_cc.entity = forward_e.tail
      where e.room in (${tidPh})
        and (cc.entity is not null or forward_e.tail is not null)
      group by e.room
    `;

    console.log(`\n  EXPLAIN QUERY PLAN:`);
    console.log(explainQueryPlan(db, latestTsSql, tidList));

    const latestTsTiming = await benchQuery("threadActivity(latestTs)", asyncDb, latestTsSql, tidList);
    console.log(`\n  Timing: ${formatTiming(latestTsTiming)}`);

    // ── 3d. threadActivity participants ──────────────────────────────────
    console.log(`\n── Query 3d: threadActivity (participants) ──`);
    const participantsSql = `
      select msg.room as room,
             coalesce(author_e.tail, fwd_author_e.tail) as did,
             ci.name as name,
             ci.avatar as avatar,
             max(coalesce(cc.timestamp, fwd_cc.timestamp)) as ts
      from entities msg
      left join comp_content cc on cc.entity = msg.id
      left join edges author_e
        on author_e.head = msg.id and author_e.label = 'author'
      left join edges forward_e
        on forward_e.head = msg.id and forward_e.label = 'forward'
      left join comp_content fwd_cc on fwd_cc.entity = forward_e.tail
      left join edges fwd_author_e
        on fwd_author_e.head = forward_e.tail and fwd_author_e.label = 'author'
      left join comp_info ci
        on ci.entity = coalesce(author_e.tail, fwd_author_e.tail)
      where msg.room in (${tidPh})
        and (cc.entity is not null or forward_e.tail is not null)
        and coalesce(author_e.tail, fwd_author_e.tail) is not null
      group by msg.room, coalesce(author_e.tail, fwd_author_e.tail)
      order by msg.room, ts desc
    `;

    console.log(`\n  EXPLAIN QUERY PLAN:`);
    console.log(explainQueryPlan(db, participantsSql, tidList));

    const participantsTiming = await benchQuery("threadActivity(participants)", asyncDb, participantsSql, tidList);
    console.log(`\n  Timing: ${formatTiming(participantsTiming)}`);

    // ── 3e. threadActivity latest message ─────────────────────────────────
    console.log(`\n── Query 3e: threadActivity (latest message) ──`);
    const latestMsgSql = `
      select e.room as room,
             e.id as id,
             coalesce(cc.mime_type, fwd_cc.mime_type) as mime_type,
             coalesce(cc.data, fwd_cc.data) as data,
             coalesce(author_e.tail, fwd_author_e.tail) as author_did,
             author_info.name as author_name,
             author_info.avatar as author_avatar,
             coalesce(cc.timestamp, fwd_cc.timestamp) as timestamp
      from entities e
      left join comp_content cc on cc.entity = e.id
      left join edges author_e
        on author_e.head = e.id and author_e.label = 'author'
      left join edges forward_e
        on forward_e.head = e.id and forward_e.label = 'forward'
      left join comp_content fwd_cc on fwd_cc.entity = forward_e.tail
      left join edges fwd_author_e
        on fwd_author_e.head = forward_e.tail and fwd_author_e.label = 'author'
      left join comp_info author_info
        on author_info.entity = coalesce(author_e.tail, fwd_author_e.tail)
      where e.room in (${tidPh})
        and (cc.entity is not null or forward_e.tail is not null)
    `;

    console.log(`\n  EXPLAIN QUERY PLAN:`);
    console.log(explainQueryPlan(db, latestMsgSql, tidList));

    const latestMsgTiming = await benchQuery("threadActivity(latestMsg)", asyncDb, latestMsgSql, tidList);
    console.log(`\n  Timing: ${formatTiming(latestMsgTiming)}`);
  }

  // ── 4. joinedSpaces ────────────────────────────────────────────────────
  console.log(`\n── Query 4: joinedSpaces ──────────────────`);
  const joinedSql = `
    select
      je.tail as id,
      ci.name as name,
      ci.avatar as avatar,
      ci.description as description,
      cs.handle as handle,
      exists (
        select 1 from edges
         where head = je.tail and tail = ?1 and label = 'member'
      ) as is_member,
      exists (
        select 1 from edges
         where head = je.tail and tail = ?1 and label = 'admin'
      ) as is_admin
    from edges je
    left join comp_info ci on ci.entity = je.tail
    left join comp_space cs on cs.entity = je.tail
    where je.head = ?2
      and je.label = ?3
      and not exists (
        select 1 from comp_bans
         where entity = je.tail and user_did = ?1
      )
      and (
        exists (
          select 1 from edges
           where head = je.tail and tail = ?1 and label = 'member'
        )
        or exists (
          select 1 from edges
           where head = je.tail and tail = ?1 and label = 'admin'
        )
      )
  `;
  const joinedParams = [userDid, personalStreamDid, "joinedSpace"];

  console.log(`\n  EXPLAIN QUERY PLAN:`);
  console.log(explainQueryPlan(db, joinedSql, joinedParams));

  const joinedTiming = await benchQuery("joinedSpaces", asyncDb, joinedSql, joinedParams);
  console.log(`\n  Timing: ${formatTiming(joinedTiming)}`);

  // ── Identify slow patterns ─────────────────────────────────────────────
  console.log(`\n═══ ANALYSIS ═══\n`);

  // Check for SCAN TABLE in query plans
  for (const [label, sql, params] of [
    ["selectMessages", msgSql, msgParams],
    ["activityFeed", feedSql, feedParams],
    ["threadActivity(space)", threadSpaceSql, threadSpaceParams],
    ["joinedSpaces", joinedSql, joinedParams],
  ] as const) {
    const plan = db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{
      id: number;
      parent: number;
      notused: number;
      detail: string;
    }>;
    const scans = plan.filter((r) => r.detail.includes("SCAN"));
    if (scans.length > 0) {
      console.log(`  ${label}: ${scans.length} table scan(s) detected`);
      for (const s of scans) {
        console.log(`    ${s.detail}`);
      }
    } else {
      console.log(`  ${label}: all index seeks (no full scans)`);
    }
  }

  // ── Store results for comparison ────────────────────────────────────────
  const beforeResults = {
    selectMessages: msgTiming,
    activityFeed: feedTiming,
    threadActivity_space: threadSpaceTiming,
    threadActivity_channel: channelId ? await benchQuery("threadActivity(channel)", asyncDb,
      `select e.id as id, ci.name as name
       from entities e
       join comp_room cr on cr.entity = e.id
       left join comp_info ci on ci.entity = e.id
       join edges link_e on link_e.tail = e.id
         and link_e.label = 'link'
         and coalesce(json_extract(link_e.payload, '$.canonical_parent'), 0) = 1
       where cr.label = 'space.roomy.thread'
         and coalesce(cr.deleted, 0) = 0
         and link_e.head = ?`, [channelId]) : null,
    joinedSpaces: joinedTiming,
  };

  // ── Now add missing indexes ─────────────────────────────────────────────
  console.log(`\n═══ ADDING OPTIMIZATIONS ═══\n`);

  // Index 1: For selectMessages ORDER BY coalesce(e.sort_idx, e.id) desc
  // The existing idx_entities_room is (room, id desc) but the query orders by
  // coalesce(sort_idx, id). SQLite can't use the index for ordering with an expression.
  // We add a covering index on (room, sort_idx, id) to help the WHERE + ORDER BY.
  console.log("  Index 1: idx_entities_room_order on entities(room, sort_idx, id desc)");
  db.exec("create index if not exists idx_entities_room_order on entities(room, sort_idx, id desc)");

  // Index 2: For threadActivity space scope - comp_room(label, entity) covering index
  // The query filters cr.label = 'space.roomy.thread' and joins on cr.entity = e.id
  // idx_comp_room_label is just (label), adding (label, entity) is more selective
  console.log("  Index 2: idx_comp_room_label_entity on comp_room(label, entity)");
  db.exec("create index if not exists idx_comp_room_label_entity on comp_room(label, entity)");

  // Index 3: For threadActivity - entities(stream_id, room) for the space scope
  // The query filters e.stream_id = ? and then joins to comp_room. Adding room
  // to the stream_id index helps if SQLite uses the entities table as the driving table.
  console.log("  Index 3: idx_entities_stream_room on entities(stream_id, room)");
  db.exec("create index if not exists idx_entities_stream_room on entities(stream_id, room)");

  // Index 4: For activityFeed - the subquery `select tail from edges where head = ? and label = 'joinedSpace'`
  // Already has idx_edges_label_head (label, head). But the subquery uses head = ? AND label = 'joinedSpace'.
  // The PK is (head, tail, label) which covers head first. Let's add (head, label) for the subquery.
  // Actually idx_edges_label_head is (label, head) which is fine for label='joinedSpace' AND head=?.
  // But the subquery is `head = ? AND label = 'joinedSpace'` - the PK (head, tail, label) already
  // covers head = ? efficiently. Let's check if there's an issue with the main activity_item query.

  // Index 5: For activityFeed - comp_room(entity, deleted) covering index
  // The query joins cr.entity = ai.room_id and filters cr.deleted. comp_room PK is entity.
  // Adding (entity, deleted) would be a covering index.
  console.log("  Index 5: idx_comp_room_entity_deleted on comp_room(entity, deleted)");
  db.exec("create index if not exists idx_comp_room_entity_deleted on comp_room(entity, deleted)");

  // Index 6: For threadActivity participants/latestMsg - edges(label, head, tail) for forward lookups
  // The queries use `forward_e.head = msg.id AND forward_e.label = 'forward'`
  // idx_edges_label_head is (label, head) which covers this perfectly.
  // But the fwd_author_e join uses `fwd_author_e.head = forward_e.tail AND fwd_author_e.label = 'author'`
  // which also uses idx_edges_label_head.

  // Index 7: For threadActivity - comp_content(entity, timestamp) for the coalesce pattern
  // The queries use `coalesce(cc.timestamp, fwd_cc.timestamp)` and join on cc.entity = e.id
  // comp_content PK is entity, so the join is already efficient.
  // Adding (entity, timestamp) would be a covering index for the timestamp access.
  console.log("  Index 7: idx_comp_content_entity_timestamp on comp_content(entity, timestamp)");
  db.exec("create index if not exists idx_comp_content_entity_timestamp on comp_content(entity, timestamp)");

  // Index 8: For joinedSpaces - edges(tail, label) for the is_member/is_admin subqueries
  // The subqueries use `head = je.tail AND tail = ?1 AND label = 'member'`
  // The PK is (head, tail, label) which covers this. But the subquery is executed per row.
  // Adding (head, label, tail) would be a covering index.
  // Actually idx_edges_label_head is (label, head) which covers label='member' AND head=je.tail.
  // The PK (head, tail, label) also covers head=je.tail. Both should be fine.

  // Index 9: For comp_bans lookup in joinedSpaces
  // The subquery uses `entity = je.tail AND user_did = ?1`
  // comp_bans PK is (entity, user_did) which is perfect.
  // idx_comp_bans_user_did is (user_did) which is also useful.

  // ── AFTER: Re-benchmark ────────────────────────────────────────────────
  console.log(`\n═══ AFTER OPTIMIZATIONS ═══\n`);

  // 1. selectMessages
  console.log(`── Query 1: selectMessages (room scope) ──`);
  console.log(`\n  EXPLAIN QUERY PLAN:`);
  console.log(explainQueryPlan(db, msgSql, msgParams));
  const msgTimingAfter = await benchQuery("selectMessages", asyncDb, msgSql, msgParams);
  console.log(`\n  Timing: ${formatTiming(msgTimingAfter)}`);

  // 2. activityFeed
  console.log(`\n── Query 2: activityFeed ────────────────`);
  console.log(`\n  EXPLAIN QUERY PLAN:`);
  console.log(explainQueryPlan(db, feedSql, feedParams));
  const feedTimingAfter = await benchQuery("activityFeed", asyncDb, feedSql, feedParams);
  console.log(`\n  Timing: ${formatTiming(feedTimingAfter)}`);

  // 3a. threadActivity (space)
  console.log(`\n── Query 3a: threadActivity (space scope) ──`);
  console.log(`\n  EXPLAIN QUERY PLAN:`);
  console.log(explainQueryPlan(db, threadSpaceSql, threadSpaceParams));
  const threadSpaceTimingAfter = await benchQuery("threadActivity(space)", asyncDb, threadSpaceSql, threadSpaceParams);
  console.log(`\n  Timing: ${formatTiming(threadSpaceTimingAfter)}`);

  // 3b. threadActivity (channel)
  if (channelId) {
    console.log(`\n── Query 3b: threadActivity (channel scope) ──`);
    const threadChannelSql2 = `
      select e.id as id, ci.name as name
      from entities e
      join comp_room cr on cr.entity = e.id
      left join comp_info ci on ci.entity = e.id
      join edges link_e on link_e.tail = e.id
        and link_e.label = 'link'
        and coalesce(json_extract(link_e.payload, '$.canonical_parent'), 0) = 1
      where cr.label = 'space.roomy.thread'
        and coalesce(cr.deleted, 0) = 0
        and link_e.head = ?
    `;
    console.log(`\n  EXPLAIN QUERY PLAN:`);
    console.log(explainQueryPlan(db, threadChannelSql2, [channelId]));
    const threadChannelTimingAfter = await benchQuery("threadActivity(channel)", asyncDb, threadChannelSql2, [channelId]);
    console.log(`\n  Timing: ${formatTiming(threadChannelTimingAfter)}`);
  }

  // 3c-e. threadActivity sub-queries
  if (tidList.length > 0) {
    const latestTsSql = `
      select e.room as room,
             max(coalesce(cc.timestamp, fwd_cc.timestamp)) as ts
      from entities e
      left join comp_content cc on cc.entity = e.id
      left join edges forward_e
        on forward_e.head = e.id and forward_e.label = 'forward'
      left join comp_content fwd_cc on fwd_cc.entity = forward_e.tail
      where e.room in (${tidPh})
        and (cc.entity is not null or forward_e.tail is not null)
      group by e.room
    `;
    const participantsSql = `
      select msg.room as room,
             coalesce(author_e.tail, fwd_author_e.tail) as did,
             ci.name as name,
             ci.avatar as avatar,
             max(coalesce(cc.timestamp, fwd_cc.timestamp)) as ts
      from entities msg
      left join comp_content cc on cc.entity = msg.id
      left join edges author_e
        on author_e.head = msg.id and author_e.label = 'author'
      left join edges forward_e
        on forward_e.head = msg.id and forward_e.label = 'forward'
      left join comp_content fwd_cc on fwd_cc.entity = forward_e.tail
      left join edges fwd_author_e
        on fwd_author_e.head = forward_e.tail and fwd_author_e.label = 'author'
      left join comp_info ci
        on ci.entity = coalesce(author_e.tail, fwd_author_e.tail)
      where msg.room in (${tidPh})
        and (cc.entity is not null or forward_e.tail is not null)
        and coalesce(author_e.tail, fwd_author_e.tail) is not null
      group by msg.room, coalesce(author_e.tail, fwd_author_e.tail)
      order by msg.room, ts desc
    `;
    const latestMsgSql = `
      select e.room as room,
             e.id as id,
             coalesce(cc.mime_type, fwd_cc.mime_type) as mime_type,
             coalesce(cc.data, fwd_cc.data) as data,
             coalesce(author_e.tail, fwd_author_e.tail) as author_did,
             author_info.name as author_name,
             author_info.avatar as author_avatar,
             coalesce(cc.timestamp, fwd_cc.timestamp) as timestamp
      from entities e
      left join comp_content cc on cc.entity = e.id
      left join edges author_e
        on author_e.head = e.id and author_e.label = 'author'
      left join edges forward_e
        on forward_e.head = e.id and forward_e.label = 'forward'
      left join comp_content fwd_cc on fwd_cc.entity = forward_e.tail
      left join edges fwd_author_e
        on fwd_author_e.head = forward_e.tail and fwd_author_e.label = 'author'
      left join comp_info author_info
        on author_info.entity = coalesce(author_e.tail, fwd_author_e.tail)
      where e.room in (${tidPh})
        and (cc.entity is not null or forward_e.tail is not null)
    `;

    console.log(`\n── Query 3c: threadActivity (latest timestamps) ──`);
    console.log(`\n  EXPLAIN QUERY PLAN:`);
    console.log(explainQueryPlan(db, latestTsSql, tidList));
    const latestTsTimingAfter = await benchQuery("threadActivity(latestTs)", asyncDb, latestTsSql, tidList);
    console.log(`\n  Timing: ${formatTiming(latestTsTimingAfter)}`);

    console.log(`\n── Query 3d: threadActivity (participants) ──`);
    console.log(`\n  EXPLAIN QUERY PLAN:`);
    console.log(explainQueryPlan(db, participantsSql, tidList));
    const participantsTimingAfter = await benchQuery("threadActivity(participants)", asyncDb, participantsSql, tidList);
    console.log(`\n  Timing: ${formatTiming(participantsTimingAfter)}`);

    console.log(`\n── Query 3e: threadActivity (latest message) ──`);
    console.log(`\n  EXPLAIN QUERY PLAN:`);
    console.log(explainQueryPlan(db, latestMsgSql, tidList));
    const latestMsgTimingAfter = await benchQuery("threadActivity(latestMsg)", asyncDb, latestMsgSql, tidList);
    console.log(`\n  Timing: ${formatTiming(latestMsgTimingAfter)}`);
  }

  // 4. joinedSpaces
  console.log(`\n── Query 4: joinedSpaces ──────────────────`);
  console.log(`\n  EXPLAIN QUERY PLAN:`);
  console.log(explainQueryPlan(db, joinedSql, joinedParams));
  const joinedTimingAfter = await benchQuery("joinedSpaces", asyncDb, joinedSql, joinedParams);
  console.log(`\n  Timing: ${formatTiming(joinedTimingAfter)}`);

  // ── Before/After comparison ────────────────────────────────────────────
  console.log(`\n═══ BEFORE / AFTER COMPARISON ═══\n`);
  console.log(`  ${"Query".padEnd(35)} ${"Before (avg)".padEnd(15)} ${"After (avg)".padEnd(15)} ${"Change".padEnd(15)}`);

  function compare(label: string, before: Timing, after: Timing) {
    const beforeStr = formatMs(before.avg).padStart(14);
    const afterStr = formatMs(after.avg).padStart(14);
    const ratio = before.avg > 0 ? (after.avg / before.avg) : 1;
    const changeStr = ratio < 1
      ? `-${((1 - ratio) * 100).toFixed(0)}%`.padStart(14)
      : `+${((ratio - 1) * 100).toFixed(0)}%`.padStart(14);
    console.log(`  ${label.padEnd(35)} ${beforeStr} ${afterStr} ${changeStr}`);
  }

  compare("selectMessages", msgTiming, msgTimingAfter);
  compare("activityFeed", feedTiming, feedTimingAfter);
  compare("threadActivity(space)", threadSpaceTiming, threadSpaceTimingAfter);
  if (channelId && beforeResults.threadActivity_channel) {
    compare("threadActivity(channel)", beforeResults.threadActivity_channel, await benchQuery("threadActivity(channel)", asyncDb,
      `select e.id as id, ci.name as name
       from entities e
       join comp_room cr on cr.entity = e.id
       left join comp_info ci on ci.entity = e.id
       join edges link_e on link_e.tail = e.id
         and link_e.label = 'link'
         and coalesce(json_extract(link_e.payload, '$.canonical_parent'), 0) = 1
       where cr.label = 'space.roomy.thread'
         and coalesce(cr.deleted, 0) = 0
         and link_e.head = ?`, [channelId]));
  }
  compare("joinedSpaces", joinedTiming, joinedTimingAfter);

  // ── Cleanup ────────────────────────────────────────────────────────────
  db.close();
  eventsDb.close();

  console.log(`\n═══ Done ═══`);
}

await main();
