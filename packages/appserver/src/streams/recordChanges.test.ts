/**
 * The interim change feed: what it writes, and that replaying it reproduces the
 * live projection.
 *
 * `docs/plans/replicable-space-workers.md` §5 WS4 makes the feed the worker's
 * input. The properties that has to hold are checked here: the rows are the
 * adapter's own output, the feed carries the entry's actor and event id, an
 * entry with no record writes nothing, a re-run overwrites rather than
 * duplicates, and a projection built from the rows equals one built from the
 * log.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { Event, StreamDid } from "@roomy-space/sdk";

import { closeDb, openDb } from "../db/db.ts";
import { toAsyncDb } from "../db/syncAdapter.ts";
import type { DbLike } from "../db/types.ts";
import { applyBatch } from "../materialization/applyBatch.ts";
import {
  CORPUS_RECEIVED_AT,
  CORPUS_STREAM,
  CORPUS_USER,
  FIXTURE_ORDER,
  buildCorpus,
  logged,
  sample,
  type Fixture,
} from "../materialization/records/corpus.ts";
import { applyDerivedStep } from "../materialization/derivedSteps.ts";
import type { Effect } from "../materialization/records/effects.ts";
import {
  planChanges,
  recordEntryEffects,
  type RoutedEvent,
} from "../materialization/records/recordPath.ts";
import { toRecordChanges } from "../materialization/records/toRecordChanges.ts";
import type { LoggedEvent } from "../materialization/types.ts";
import {
  diffSnapshots,
  digestOf,
  snapshotSpaceDb,
  workerSnapshot,
} from "./rebuildEquality.ts";
import {
  feedRows,
  readRecordChanges,
  rowToChange,
  writeRecordChanges,
} from "./recordChanges.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, "..", "db", "schema-space.sql");
const GLOBAL_SCHEMA_PATH = join(__dirname, "..", "db", "schema-global.sql");
const EVENTS_SCHEMA_PATH = join(__dirname, "..", "db", "eventsSchema.sql");

const STREAM = CORPUS_STREAM;

// `applyBatch`'s side-effect path opens the read-state DB through the worker, so
// point the worker at an in-memory DB for the duration of a test.
beforeEach(() => {
  closeDb();
  openDb({ path: ":memory:" });
});
afterEach(() => {
  closeDb();
});

function freshSpaceDb(): Database {
  const db = new Database(":memory:");
  db.exec("pragma foreign_keys = on");
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  db.run("insert into entities (id, stream_id) values (?, ?)", [STREAM, STREAM]);
  db.run("insert into comp_space (entity) values (?)", [STREAM]);
  return db;
}

function freshGlobalDb(): Database {
  const db = new Database(":memory:");
  db.exec("pragma foreign_keys = on");
  db.exec(readFileSync(GLOBAL_SCHEMA_PATH, "utf8"));
  return db;
}

function freshEventsDb(): Database {
  const db = new Database(":memory:");
  db.exec(readFileSync(EVENTS_SCHEMA_PATH, "utf8"));
  return db;
}

/**
 * Apply a planned batch the way the worker does: the SQL effects in order, then
 * each entry's derived steps. This is the consumer the feed exists for, without
 * the log entries, side effects or savepoints the write path adds.
 */
async function applyPlan(
  space: DbLike,
  global: DbLike,
  plans: readonly (RoutedEvent | null)[],
  streamId: StreamDid,
): Promise<void> {
  // A batch applies every entry's SQL before any entry's derived step, which is
  // what lets a window rebuilt by one change see the rows the batch's other
  // changes wrote — the order `applyBatch` uses for a chunk.
  const planned = plans
    .filter((plan): plan is RoutedEvent => plan !== null)
    .map((plan) => recordEntryEffects(plan, { streamId, isBackfill: false }));

  for (const effects of planned) {
    for (const effect of effects) {
      if (effect.effect !== "sql") continue;
      if (effect.target === "global") {
        await global.run(effect.sql, ...(effect.params as never[]));
      } else {
        await space.run(effect.sql, ...(effect.params as never[]));
      }
      if (effect.sql.trim().startsWith("insert into entities")) {
        const [id, sid] = effect.params as [unknown, unknown];
        if (typeof id === "string" && typeof sid === "string" && sid !== "") {
          await global.run(
            "insert or ignore into entity_space (entity_id, space_did) values (?, ?)",
            [id, sid],
          );
        }
      }
    }
  }

  for (const effects of planned) {
    for (const effect of effects) {
      if (effect.effect === "sql") continue;
      await applyDerivedStep(space, effect, global);
    }
  }
}

describe("the feed is the adapter's own output", () => {
  test("every row equals what toRecordChanges emitted for its entry", () => {
    const { entries } = buildCorpus();
    let rows = 0;
    for (const entry of entries) {
      const expected = toRecordChanges(entry, STREAM);
      const got = feedRows(entry, STREAM);
      expect(got.length).toBe(expected.length);
      expected.forEach((change, ord) => {
        const row = got[ord]!;
        expect(row.kind).toBe(change.kind);
        expect(row.repo).toBe(change.repo);
        expect(row.collection).toBe(change.collection);
        expect(row.rkey).toBe(change.rkey);
        expect(row.op).toBe(change.op);
        expect(row.orderStamp).toBe(change.orderStamp);
        expect(row.actor).toBe(CORPUS_USER);
        expect(row.eventId).toBe(entry.event.id);
        expect(row.idx).toBe(entry.idx);
        expect(row.ord).toBe(ord);
        rows++;
      });
      // A decoded row is the change the adapter emitted.
      for (const row of got) expect(rowToChange(row)).toEqual(
        expected[row.ord]!,
      );
    }
    expect(rows).toBeGreaterThan(FIXTURE_ORDER.length);
  }, 30_000);

  test("an entry that emits no record writes no rows", () => {
    const fx = { ...(buildCorpus().fx) } as Fixture;
    for (const $type of [
      "space.roomy.space.setHandleProvider.v0",
      "space.roomy.page.editPage.v0",
      "space.roomy.message.reorderMessage.v0",
      "space.roomy.state.markRead.v0",
    ] as const) {
      const entry = logged(sample($type, fx, () => crypto.randomUUID()), 1);
      expect(feedRows(entry, STREAM)).toEqual([]);
    }
  });
});

describe("replaying the feed reproduces the live projection", () => {
  // The write path's projection and the feed's, built and digested twice: the
  // heaviest check in the file, so it gets a budget a loaded runner survives.
  test("the space and global DBs match the write path's", async () => {
    // A feed-fed projection can only reproduce entries that emit a record;
    // `setHandleProvider` writes a column with no readers and carries none.
    const { entries } = buildCorpus({ recordProducingOnly: true });

    // The live path: applyBatch over the log, through the record rules.
    const liveSpaceRaw = freshSpaceDb();
    const liveSpace = toAsyncDb(liveSpaceRaw);
    const liveGlobal = toAsyncDb(freshGlobalDb());
    const stats = await applyBatch(liveSpace, STREAM, entries, {
      isBackfill: false,
    }, liveGlobal);
    expect(stats.applyErrors).toBe(0);

    // The feed: what the write path would have persisted for the same entries.
    const eventsDb = freshEventsDb();
    const events = toAsyncDb(eventsDb);
    await writeRecordChanges(events, STREAM, entries);

    const rows = await readRecordChanges(
      events,
      STREAM,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    expect(rows.length).toBeGreaterThan(0);
    // `(idx, ord)` is the order the worker applies changes in.
    const sorted = [...rows].sort((a, b) =>
      a.idx !== b.idx ? a.idx - b.idx : a.ord - b.ord,
    );
    expect(rows.map((r) => `${r.idx}/${r.ord}`)).toEqual(
      sorted.map((r) => `${r.idx}/${r.ord}`),
    );

    // Group by entry, then plan and apply exactly as the worker would.
    const byIdx = new Map<number, typeof rows>();
    for (const row of rows) {
      const group = byIdx.get(row.idx) ?? [];
      group.push(row);
      byIdx.set(row.idx, group);
    }
    const feedSpaceRaw = freshSpaceDb();
    const feedSpace = toAsyncDb(feedSpaceRaw);
    const feedGlobal = toAsyncDb(freshGlobalDb());
    const batch = [...byIdx.entries()].map(([idx, group]) => {
      const first = group[0]!;
      // The planner reads the entry's identity only; the record carries the
      // rest, which is what makes the feed a complete input.
      const entry = {
        event: { id: first.eventId } as Event,
        idx: idx as never,
        user: first.actor as never,
        receivedAt: CORPUS_RECEIVED_AT,
      } as LoggedEvent;
      return { entry, changes: group.map(rowToChange) };
    });
    const plans = await planChanges(feedSpace, batch);
    await applyPlan(feedSpace, feedGlobal, plans, STREAM);

    const live = workerSnapshot(await snapshotSpaceDb(liveSpace));
    const feed = workerSnapshot(await snapshotSpaceDb(feedSpace));
    expect(diffSnapshots(live, feed).map((d) => d.table)).toEqual([]);
    expect(digestOf(feed)).toBe(digestOf(live));

    // The global DB holds the same rule-written rows on both sides.
    for (const sql of [
      "select head, tail, label from edges order by head, tail, label",
      `select space_id, federating_space_did, room_id, permission
         from federation_room_permissions order by space_id, federating_space_did, room_id`,
      `select space_id, federating_space_did, room_id, grantee, kind, permission
         from federation_receiver_permissions order by 1, 2, 3, 4, 5`,
      "select room_id, space_id, call_id, started_at from voice_projected_calls order by room_id",
      "select entity_id, space_did from entity_space order by entity_id",
    ]) {
      expect(await feedGlobal.query(sql).all()).toEqual(
        await liveGlobal.query(sql).all(),
      );
    }
  }, 30_000);
});

describe("the backfill is idempotent", () => {
  test("writing the same entries twice leaves one row per change", async () => {
    const { entries } = buildCorpus();
    const events = toAsyncDb(freshEventsDb());

    await writeRecordChanges(events, STREAM, entries);
    const first = await readRecordChanges(events, STREAM, 0, 10_000);
    await writeRecordChanges(events, STREAM, entries);
    const second = await readRecordChanges(events, STREAM, 0, 10_000);

    expect(second.length).toBe(first.length);
    expect(second).toEqual(first);
  });

  test("a partly written feed is completed by a re-run", async () => {
    const { entries } = buildCorpus();
    const events = toAsyncDb(freshEventsDb());

    await writeRecordChanges(events, STREAM, entries.slice(0, 5));
    const partial = (await readRecordChanges(events, STREAM, 0, 10_000)).length;
    await writeRecordChanges(events, STREAM, entries);
    const complete = await readRecordChanges(events, STREAM, 0, 10_000);
    expect(complete.length).toBeGreaterThan(partial);
  });
});
