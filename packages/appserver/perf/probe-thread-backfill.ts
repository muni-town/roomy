#!/usr/bin/env bun
/**
 * Before/after probe for the lazy thread-activity backfill
 * (`queries/userActiveThreads.ts`), which `space.getMetadata` runs for a reader
 * with no `user_thread_activity` rows in the space.
 *
 * The fixture is the shape that made the backfill a per-read cost: one member
 * who has authored a message in every thread of the space, all of them older
 * than the activity window. The old path answered that by joining every one of
 * those messages through `comp_content` and `comp_room`; the new path reads the
 * per-room author list from `room_activity`, and records the empty answer so the
 * next read does not derive it again.
 *
 * Measured, all on the same fixture:
 *
 *   before      `queryActiveThreads` against a DB whose `room_activity` cannot
 *               answer, which is the scan the replaced code always ran.
 *   cold        the new path with an empty projection — the one read that pays
 *               the projection warm.
 *   warm        the new path with the projection populated, no marker: the cost
 *               of the one read per window that re-derives the answer.
 *   marked      the second and later reads, which the recorded empty answer
 *               answers without touching the space DB at all.
 *
 * Usage:
 *   bun run perf/probe-thread-backfill.ts [--threads 4000] [--messages 20]
 *     [--filler 20000] [--runs 5]
 */

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { toAsyncDb } from "../src/db/syncAdapter.ts";
import type { DbLike } from "../src/db/types.ts";
import { queryActiveThreads } from "../src/queries/userActiveThreads.ts";

const arg = (name: string, fallback: number): number => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.slice(name.length + 3)) : fallback;
};

const THREADS = arg("threads", 4000);
const MESSAGES_PER_THREAD = arg("messages", 20);
const FILLER = arg("filler", 20_000);
const RUNS = arg("runs", 5);

const SPACE = "did:web:probe.example";
const USER = "did:plc:target";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPACE_SCHEMA = readFileSync(join(__dirname, "..", "src", "db", "schema-space.sql"), "utf8");
const READSTATE_SCHEMA = readFileSync(
  join(__dirname, "..", "src", "db", "readStateSchema.sql"),
  "utf8",
);

function openSpaceDb(): Database {
  const db = new Database(":memory:");
  db.exec("pragma journal_mode = wal");
  db.exec("pragma synchronous = normal");
  db.exec("pragma foreign_keys = on");
  db.exec(SPACE_SCHEMA);
  return db;
}

function openReadStateDb(): Database {
  const db = new Database(":memory:");
  db.exec(READSTATE_SCHEMA);
  return db;
}

/** Seed the fixture: `THREADS` threads, the member authored in all of them. */
function seed(db: Database, now: number): void {
  const oldTs = now - 200 * 60 * 60 * 1000; // older than the 120h activity window

  db.run("insert into entities (id, stream_id) values (?, ?)", [SPACE, SPACE]);
  db.run("insert into comp_space (entity) values (?)", [SPACE]);
  db.run("insert into entities (id, stream_id) values (?, ?)", [USER, SPACE]);
  db.run("insert into entities (id, stream_id) values (?, ?)", ["did:plc:other", SPACE]);

  const seq = "with recursive seq(i) as (select 1 union all select i + 1 from seq where i < ?1)";

  // Thread rooms.
  db.run(
    `${seq}
     insert into entities (id, stream_id)
     select 'thread-' || printf('%06d', i), ?2 from seq`,
    [THREADS, SPACE],
  );
  db.run(
    `insert into comp_room (entity, label, default_access)
     select id, 'space.roomy.thread', null from entities where id glob 'thread-*'`,
  );

  // Thread history authored by someone else, spread across the threads.
  db.run(
    `${seq}
     insert into entities (id, stream_id, room)
     select 'omsg-' || printf('%09d', i), ?2,
            'thread-' || printf('%06d', ((i - 1) % ?3) + 1)
       from seq`,
    [THREADS * MESSAGES_PER_THREAD, SPACE, THREADS],
  );
  db.run(
    `insert into comp_content (entity, mime_type, data, last_edit, timestamp)
     select id, 'text/plain', x'68', id, ?1 - (rowid % 1000000)
       from entities where id glob 'omsg-*'`,
    [now],
  );
  db.run(
    `insert into edges (head, tail, label)
     select id, 'did:plc:other', 'author' from entities where id glob 'omsg-*'`,
  );

  // A channel with filler messages, so the space is not just threads.
  db.run("insert into entities (id, stream_id) values ('chan-000001', ?1)", [SPACE]);
  db.run(
    `insert into comp_room (entity, label, default_access)
     values ('chan-000001', 'space.roomy.channel', 'readwrite')`,
  );
  db.run(
    `${seq}
     insert into entities (id, stream_id, room)
     select 'cmsg-' || printf('%09d', i), ?2, 'chan-000001' from seq`,
    [Math.floor(FILLER / 2), SPACE],
  );
  db.run(
    `insert into comp_content (entity, mime_type, data, last_edit, timestamp)
     select id, 'text/plain', x'68', id, ?1 - (rowid % 1000000)
       from entities where id glob 'cmsg-*'`,
    [now],
  );
  db.run(
    `insert into edges (head, tail, label)
     select id, 'did:plc:other', 'author' from entities where id glob 'cmsg-*'`,
  );

  // The member's own authored messages: one in every thread, all out of window.
  db.run(
    `${seq}
     insert into entities (id, stream_id, room)
     select 'amsg-' || printf('%09d', i), ?2, 'thread-' || printf('%06d', i) from seq`,
    [THREADS, SPACE],
  );
  db.run(
    `insert into comp_content (entity, mime_type, data, last_edit, timestamp)
     select id, 'text/plain', x'68', id, ?1 from entities where id glob 'amsg-*'`,
    [oldTs],
  );
  db.run(
    `insert into edges (head, tail, label)
     select id, ?1, 'author' from entities where id glob 'amsg-*'`,
    [USER],
  );
}

/** The space DB as the old code saw it: no projection to answer from. */
function withoutProjection(db: DbLike): DbLike {
  return {
    ...db,
    query(sql: string) {
      if (sql.includes("room_activity")) throw new Error("no such table: room_activity");
      return db.query(sql);
    },
  };
}


async function time(label: string, runs: number, fn: () => Promise<unknown>): Promise<number> {
  const timings: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = Bun.nanoseconds();
    await fn();
    timings.push((Bun.nanoseconds() - t0) / 1e6);
  }
  const best = Math.min(...timings);
  console.log(
    `  ${label.padEnd(34)} min ${best.toFixed(1).padStart(8)} ms   avg ${(timings.reduce((a, b) => a + b, 0) / runs).toFixed(1).padStart(8)} ms`,
  );
  return best;
}

const now = Date.now();
console.log(`Fixture: ${THREADS} threads, ${MESSAGES_PER_THREAD} messages each, ${FILLER} channel messages`);

const raw = openSpaceDb();
const t0 = Bun.nanoseconds();
seed(raw, now);
console.log(`Seeded in ${((Bun.nanoseconds() - t0) / 1e6 / 1000).toFixed(1)} s`);

const count = (sql: string): number => raw.query<{ c: number }, []>(sql).get()?.c ?? 0;
console.log(
  `Rows: entities ${count("select count(*) c from entities")}, comp_content ${count("select count(*) c from comp_content")}, edges ${count("select count(*) c from edges")}, comp_room ${count("select count(*) c from comp_room")}`,
);
console.log(
  `The member's authored messages in the space: ${count(`select count(*) c from edges where label = 'author' and tail = '${USER}'`)} (all out of the 120h window)\n`,
);

console.log("── Before: the live scan the backfill replaced ──");
const scanSql = `select e.room as room, max(cc.timestamp) as ts
   from entities e
   join comp_content cc on cc.entity = e.id
   join edges author_e on author_e.head = e.id and author_e.label = 'author'
   join comp_room cr on cr.entity = e.room and cr.label = 'space.roomy.thread'
  where author_e.tail = ?
    and e.stream_id = ?
    and cc.timestamp > ?
  group by e.room`;
const plan = raw
  .query<{ detail: string }, [string, string, number]>(`explain query plan ${scanSql}`)
  .all(USER, SPACE, now);
for (const row of plan) console.log(`    ${row.detail}`);
await time("live scan (statement alone)", RUNS, async () =>
  raw.query(scanSql).all(USER, SPACE, now),
);
await time("queryActiveThreads, scan path", RUNS, async () => {
  await queryActiveThreads(toAsyncDb(openReadStateDb()), withoutProjection(toAsyncDb(raw)), USER, SPACE);
});

console.log("\n── After: the two reads the backfill makes instead ──");
const threadRoomsSql = `select e.id as id
   from entities e
   join comp_room cr on cr.entity = e.id
  where e.stream_id = ?
    and cr.label = 'space.roomy.thread'`;
for (const row of raw
  .query<{ detail: string }, [string]>(`explain query plan ${threadRoomsSql}`)
  .all(SPACE)) {
  console.log(`    ${row.detail}`);
}
for (const row of raw
  .query<{ detail: string }, []>(
    "explain query plan select room_id, recent_authors from room_activity where room_id = 'thread-000001'",
  )
  .all()) {
  console.log(`    ${row.detail}`);
}

// A cold reader: no marker, and the projection already answers. This is what
// every read after the first one in a window costs. The prime read below warms
// the projection first, so the timed runs measure the read and not the warm.
await queryActiveThreads(toAsyncDb(openReadStateDb()), toAsyncDb(raw), USER, SPACE);
await time("queryActiveThreads, warm projection", RUNS, async () => {
  await queryActiveThreads(toAsyncDb(openReadStateDb()), toAsyncDb(raw), USER, SPACE);
});

// The one read that pays the projection warm, measured on a DB whose rows were
// just dropped — the state a replay leaves behind.
raw.run("delete from room_activity");
const coldStart = Bun.nanoseconds();
await queryActiveThreads(toAsyncDb(openReadStateDb()), toAsyncDb(raw), USER, SPACE);
console.log(
  `  ${"queryActiveThreads, cold projection".padEnd(34)} first read ${((Bun.nanoseconds() - coldStart) / 1e6).toFixed(1).padStart(8)} ms`,
);

// Every later read: the recorded empty answer, and no per-space work at all.
const markedReadState = openReadStateDb();
const markedSpace = toAsyncDb(raw);
let statements = 0;
const countingSpace: DbLike = {
  ...markedSpace,
  query(sql: string) {
    statements++;
    return markedSpace.query(sql);
  },
  run(sql: string, ...params: unknown[]) {
    statements++;
    return markedSpace.run(sql, ...params);
  },
};
await queryActiveThreads(toAsyncDb(markedReadState), countingSpace, USER, SPACE);
const before = statements;
await time("queryActiveThreads, recorded empty", RUNS, () =>
  queryActiveThreads(toAsyncDb(markedReadState), countingSpace, USER, SPACE),
);
console.log(`  per-space statements over the ${RUNS} timed reads: ${statements - before}`);

const rooms = count(`select count(*) c from entities e join comp_room cr on cr.entity = e.id where cr.label = 'space.roomy.thread' and e.stream_id = '${SPACE}'`);
const projected = count("select count(*) c from room_activity");
console.log(`\nProjection after the warm: ${projected} rows for ${rooms} thread rooms`);
