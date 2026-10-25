/**
 * Materialisation purity tests (plan: docs/plans/pure-materialisation.md §6
 * P3/P5/P7).
 *
 * The per-space DB is a deterministic projection of the event log, except for
 * values the log does not determine. These tests pin that:
 *
 *   P3 — the same log materialised twice holds the same rows, the second time
 *        through the real rebuild path (blue-green: replay into a fresh DB and
 *        swap it in).
 *   P5 — materialising a log makes no outbound network call.
 *   P7 — no per-space table has a writer outside materialisation, beyond the
 *        documented read-path caches, and a replay invalidates those rather
 *        than merging into a stale row.
 *
 * The comparison itself lives in `rebuildEquality.ts`: an oracle any
 * implementation can call against any per-space DB, which is what makes it
 * usable for the TS-vs-Rust check as well. What stays here is the log these
 * assertions run over, and the assertion that the exclusions the oracle applies
 * are the ones they claim to be — an exclusion list that silently covered a
 * log-determined value would hide exactly the regression this file exists to
 * catch.
 *
 * Self-contained (one shared pool, real temp `spacesDir`, no `openDb()`
 * singleton churn) for the reason documented in reMaterialize.blueGreen.test.ts.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { encode } from "@atcute/cbor";
import {
  createDefaultSpaceEvents,
  newUlid,
  parseEvent,
  StreamDid,
  UserDid,
  type Event,
} from "@roomy-space/sdk";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabasePool } from "../db/pool.ts";
import { GLOBAL_SCHEMA_VERSION, SPACE_SCHEMA_VERSION } from "../db/db.ts";
import { READSTATE_SCHEMA_VERSION } from "../db/readStateDb.ts";
import type { DbLike } from "../db/types.ts";
import { StreamManager } from "./StreamManager.ts";
import { selectMessages } from "../queries/selectMessages.ts";
import { _resetProfileNegativeCache } from "../materialization/profiles.ts";
import {
  _startSweeperNoLoop,
  stopEmbedSweeper,
  sweepCycle,
} from "../embed/sweeper.ts";
import {
  CLOCK_COLUMNS,
  TABLE_CLOCK_COLUMNS,
  READ_PATH_CACHES,
  materialiseAndDiff,
  materialiseFromLog,
  recordFetchCalls,
  snapshotSpaceDb,
  staleCanonicalDb,
} from "./rebuildEquality.ts";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const ADMIN = UserDid.assert("did:plc:purity-admin");
const OTHER = UserDid.assert("did:plc:purity-other");

describe("materialisation purity", () => {
  let pool: DatabasePool;
  let router: DbLike;
  let spacesDir: string;
  let globalPath: string;
  let nextSpace = 0;
  let streamDid: StreamDid;

  beforeAll(async () => {
    spacesDir = mkdtempSync(join(tmpdir(), "roomy-purity-"));
    // The global DB is a FILE, not `:memory:`, because a `:memory:` DB in a
    // worker is private to that worker: the global worker's copy would not be
    // the one a per-space worker's `global()` route reaches, so the link-embed
    // store would be empty on every read that crosses workers. The space and
    // read-state DBs stay in memory — a per-space DB is pinned to one worker by
    // `hashSpace`, so both its writer and its readers land on the same one.
    globalPath = join(spacesDir, "..", "global.sqlite");
    pool = new DatabasePool(1, join(THIS_DIR, "../db/worker.ts"));
    await pool.init({
      readStateDbPath: ":memory:",
      eventsDbPath: ":memory:",
      globalDbPath: globalPath,
      spacesDir,
      readStateSchemaVersion: READSTATE_SCHEMA_VERSION,
      spaceSchemaVersion: SPACE_SCHEMA_VERSION,
      globalSchemaVersion: GLOBAL_SCHEMA_VERSION,
    });
    router = pool.router();
  });

  afterAll(async () => {
    await pool.close();
    rmSync(spacesDir, { recursive: true, force: true });
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(globalPath + suffix, { force: true });
    }
  });

  beforeEach(() => {
    // A unique space per test, so the worker's handle cache never carries one
    // test's DB into the next.
    streamDid = StreamDid.assert(`did:web:purity-${nextSpace++}.example`);
  });

  function parse(raw: Record<string, unknown>): Event {
    const parsed = parseEvent(raw);
    if (!parsed.success) throw new Error(parsed.error);
    return parsed.data;
  }

  /** Seed a log row for `event`, stamped with a server receipt instant. */
  async function seedEvent(
    db: DbLike,
    event: Event,
    idx: number,
    receivedAt: number,
  ): Promise<void> {
    await db.run(
      `insert into stream_events (stream_id, idx, user, payload, signature, event_type, created_at, received_at)
       values (?, ?, ?, ?, x'', ?, ?, ?)`,
      streamDid,
      idx,
      ADMIN,
      encode(event as Parameters<typeof encode>[0]),
      event.$type,
      receivedAt,
      receivedAt,
    );
  }

  /**
   * Seed a log covering every kind of derived row the per-space DB holds: the
   * space's own info and sidebar, channels, a threaded reply, a reaction, a
   * role, an invite, a room link, voice call facts, a move and an admin grant.
   */
  async function seedRichLog(): Promise<void> {
    const receivedAt = Date.now();
    const channelId = newUlid();
    const threadId = newUlid();
    const messageId = newUlid();
    const forwardedId = newUlid();
    const threadMessageId = newUlid();

    const events: Event[] = [
      ...(createDefaultSpaceEvents({ name: "Purity" }) as Event[]),
      parse({
        id: channelId,
        $type: "space.roomy.room.createRoom.v0",
        kind: "space.roomy.channel",
        name: "general",
      }),
      parse({
        id: threadId,
        $type: "space.roomy.room.createRoom.v0",
        kind: "space.roomy.thread",
        name: "a thread",
      }),
      parse({
        id: newUlid(),
        $type: "space.roomy.link.createRoomLink.v0",
        room: channelId,
        linkToRoom: threadId,
        isCreationLink: true,
      }),
      parse({
        id: messageId,
        room: channelId,
        $type: "space.roomy.message.createMessage.v0",
        body: {
          mimeType: "text/plain",
          data: {
            $bytes: Buffer.from("hello https://example.com/a").toString("base64"),
          },
        },
        extensions: {},
      }),
      parse({
        id: threadMessageId,
        room: threadId,
        $type: "space.roomy.message.createMessage.v0",
        body: {
          mimeType: "text/plain",
          data: { $bytes: Buffer.from("in a thread").toString("base64") },
        },
        extensions: {},
      }),
      parse({
        id: forwardedId,
        room: channelId,
        $type: "space.roomy.message.forwardMessages.v0",
        messageIds: [threadMessageId],
        fromRoomId: threadId,
      }),
      parse({
        id: newUlid(),
        room: channelId,
        $type: "space.roomy.reaction.addReaction.v0",
        reactionTo: messageId,
        reaction: "🔥",
      }),
      parse({
        id: newUlid(),
        $type: "space.roomy.role.createRole.v0",
        name: "moderator",
        description: "keeps the peace",
      }),
      parse({
        id: newUlid(),
        $type: "space.roomy.space.createInvite.v0",
        token: "invite-token-1",
      }),
      parse({
        id: newUlid(),
        room: channelId,
        $type: "space.roomy.voice.callStarted.v0",
        callId: newUlid(),
        source: "user",
      }),
      parse({
        id: newUlid(),
        $type: "space.roomy.space.addAdmin.v0",
        userDid: OTHER,
      }),
      // A move, so the room-rewriting paths are exercised too.
      parse({
        id: newUlid(),
        room: channelId,
        toRoomId: threadId,
        $type: "space.roomy.message.moveMessages.v0",
        messageIds: [forwardedId],
      }),
    ];

    for (let i = 0; i < events.length; i++) {
      await seedEvent(router, events[i]!, i, receivedAt);
    }
  }

  test("the same log materialised twice yields identical per-space state", async () => {
    await seedRichLog();

    // ── First derivation: replay into the empty canonical DB ────────────
    await materialiseFromLog(router, streamDid);

    // ── Second derivation: the same log, rebuilt into a fresh DB ────────
    // `materialiseAndDiff` reads the first derivation off the canonical DB,
    // then rebuilds the space from the log into a fresh one and diffs the two.
    const { before, after, diverging } = await materialiseAndDiff(
      router,
      streamDid,
    );

    // Sanity: the derivation wrote rows, so the equality below is not the
    // equality of two empty databases.
    expect(before.some((t) => t.rows.length > 0)).toBe(true);

    // P3: every derived table holds the same rows in both derivations.
    expect(diverging).toEqual([]);
    expect(after).toEqual(before);
  });

  test("the clock columns the snapshot drops are derivation-time values", async () => {
    // The exclusion list is load-bearing only if those columns really do carry
    // the derivation instant, and only if it is the list anyone expects. The
    // names are pinned first: widening the list is how a log-determined value
    // would get hidden, so it has to be an explicit edit here as well.
    expect(Object.keys(CLOCK_COLUMNS)).toEqual([
      "fetched_at",
      "synced_at",
      "retry_after",
    ]);
    expect(
      Object.fromEntries(
        Object.entries(TABLE_CLOCK_COLUMNS).map(([table, columns]) => [
          table,
          Object.keys(columns),
        ]),
      ),
    ).toEqual({
      activity_item: ["created_at", "updated_at"],
      comp_last_read: ["created_at", "updated_at"],
      pending_links: ["created_at"],
      voice_projected_calls: ["created_at"],
    });

    // Then the behaviour, from both sides of the line.
    //
    // `entities.created_at` for a non-ULID id (a DID) is the instant the log
    // assigned the change — the ordering stamp's time half — so it is compared
    // by the digest and must not have come from the wall clock that ran it.
    // `activity_item.updated_at` is a derived step's own stamp, so it is
    // excluded, and this is the column that would catch the exclusion list
    // shrinking over a value nothing determines.
    await seedEvent(
      router,
      parse({
        id: newUlid(),
        $type: "space.roomy.space.updateSpaceInfo.v0",
        name: "Clocks",
      }),
      0,
      Date.now() - 60 * 60 * 1000,
    );

    const before = Date.now();
    await materialiseFromLog(router, streamDid);
    const after = Date.now();

    const row = await router.forSpace!(streamDid)
      .query("select created_at from entities where id = ?")
      .get<{ created_at: number }>(streamDid);
    expect(row!.created_at).toBeLessThan(before);
    expect(row!.created_at).toBeGreaterThan(0);

    // And the column is inside the digest: a snapshot of this space carries it.
    const snapshot = await snapshotSpaceDb(router.forSpace!(streamDid));
    const entities = snapshot.find((table) => table.table === "entities");
    expect(entities?.columns).toContain("created_at");
  });

  /**
   * Enrich a URL through the real sweeper path, so the store it writes is
   * covered by the two-derivation comparison below.
   *
   * The sweeper is the one writer of the store, and it is not part of
   * materialisation — which is exactly why the store must be outside the
   * per-space DB. This drives it against a stubbed fetch so no network call is
   * made.
   */
  async function enrichUrlThroughSweeper(url: string): Promise<void> {
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> =>
      Promise.resolve(
        new Response(
          '<html><head><meta property="og:title" content="Purity Link" />' +
            '<meta property="og:description" content="enriched" /></head></html>',
          { status: 200, headers: { "Content-Type": "text/html" } },
        ),
      )) as typeof globalThis.fetch;
    try {
      await stopEmbedSweeper();
      _startSweeperNoLoop({ globalDb: router.global!() });
      await sweepCycle(router.global!());
      await stopEmbedSweeper();
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  test("materialising a log makes no outbound network call", async () => {
    // P5: every derived value comes from the log, so the replay reaches
    // nothing. Both derivations are covered — the replay into the canonical DB
    // and the blue-green rebuild.
    //
    // The path's one network seam, profile hydration, is gone: profiles resolve
    // at read time from the global store. This assertion is what keeps it gone —
    // a derivation that grew a fetch of its own, an embed unfurl or a handle
    // lookup, is caught here whatever seam it used.
    await seedRichLog();

    const { calls } = await recordFetchCalls(async () => {
      await materialiseFromLog(router, streamDid);
      await materialiseAndDiff(router, streamDid);
    });

    expect(calls).toEqual([]);
  });

  test("the fetch spy reports the calls it refuses", async () => {
    // Guards the assertion above from passing vacuously: if the spy stopped
    // recording (a stub that resolved, a `fetch` binding captured before the
    // swap), P5 would report a clean run while the network was being reached.
    const { calls } = await recordFetchCalls(async () => {
      await fetch("https://example.invalid/probe").catch(() => undefined);
    });

    expect(calls).toEqual([
      { url: "https://example.invalid/probe", method: "GET" },
    ]);
  });

  test("a rebuilt space serves enriched link cards without the sweeper having run", async () => {
    // P6: the enrichment is a function of an outbound fetch, not of the log, so
    // it must survive a re-derivation that never runs a sweeper. A per-space
    // `comp_embed_link_data` would be empty after a rebuild and the message
    // would render a bare link; the global store is what makes it survive.
    await seedRichLog();
    await materialiseFromLog(router, streamDid);

    const url = "https://example.com/a";
    const messageId = await router.forSpace!(streamDid)
      .query(
        `select el.entity as url, e.room as message_id
           from comp_embed_link el join entities e on e.id = el.entity
          limit 1`,
      )
      .get<{ url: string; message_id: string }>();
    expect(messageId).not.toBeNull();

    await enrichUrlThroughSweeper(url);

    const spaceDb = router.forSpace!(streamDid);
    const enriched = await selectMessages(
      spaceDb,
      { kind: "ids", ids: [messageId!.message_id] },
      undefined,
      router.global!(),
    );
    expect(enriched.messages[0]?.linkEmbeds?.[0]?.embed).toMatchObject({
      t: "Purity Link",
    });

    // Re-derive the space from the log into a fresh DB — the rebuild path,
    // which runs no sweeper and cannot re-fetch anything.
    await staleCanonicalDb(router, streamDid);
    await materialiseFromLog(router, streamDid);

    const rebuilt = await selectMessages(
      router.forSpace!(streamDid),
      { kind: "ids", ids: [messageId!.message_id] },
      undefined,
      router.global!(),
    );
    expect(rebuilt.messages[0]?.linkEmbeds?.[0]?.embed).toMatchObject({
      t: "Purity Link",
    });
  });

  test("a replay invalidates the read-path caches instead of merging into them", async () => {
    await seedRichLog();
    await materialiseFromLog(router, streamDid);

    const spaceDb = router.forSpace!(streamDid);
    const room = await spaceDb
      .query("select entity from comp_room where label = 'space.roomy.channel' limit 1")
      .get<{ entity: string }>();

    // Overwrite both documented read-path caches with a sentinel a replay of
    // the log would never produce. `insert or replace` because the replay's own
    // delete/move steps may have rebuilt `room_activity` already — the point is
    // that the stale value does not survive the next replay.
    await spaceDb.run(
      `insert or replace into room_access (room_id, space_id, parent_channel_id)
       values (?, ?, null)`,
      room!.entity,
      streamDid,
    );
    await spaceDb.run(
      `insert or replace into room_activity (room_id, latest_message_id, latest_at, recent_authors)
       values (?, 'stale-message-id', 1, '[]')`,
      room!.entity,
    );

    await staleCanonicalDb(router, streamDid);
    await materialiseFromLog(router, streamDid);

    // P7: the caches hold values the log determines, so a replay invalidates
    // them rather than carrying the stale rows forward. Either the row is gone
    // (the replay never re-populates a cache) or it was rebuilt from the
    // replayed tables — never the sentinel.
    const rebuilt = router.forSpace!(streamDid);
    const staleAccess = await rebuilt
      .query("select room_id from room_access where room_id = ?")
      .get<{ room_id: string }>(room!.entity);
    expect(staleAccess).toBeNull();
    const activity = await rebuilt
      .query(
        "select latest_message_id from room_activity where room_id = ?",
      )
      .get<{ latest_message_id: string | null }>(room!.entity);
    expect(activity?.latest_message_id).not.toBe("stale-message-id");
  });

  test("a live write's rows are reproduced by a rebuild from the log", async () => {
    // The other direction of the same invariant: state written through the live
    // path (not just replayed) is what a rebuild reproduces.
    const sm = new StreamManager(router, {
      appserverUrl: "https://appserver.example",
    });
    await sm.sendEvents(
      streamDid,
      createDefaultSpaceEvents({ name: "Live" }) as Event[],
      ADMIN,
    );

    const live = await snapshotSpaceDb(router.forSpace!(streamDid));

    // The read-path caches are the one documented difference in this direction:
    // a live write warms them on the read path, a rebuild leaves them for the
    // next read to warm. Everything materialisation itself writes must match.
    const { after: rebuilt, diverging } = await materialiseAndDiff(
      router,
      streamDid,
      { before: live, ignoredTables: Object.keys(READ_PATH_CACHES) },
    );
    expect(diverging).toEqual([]);

    // The caches did not carry a stale row across — they are simply empty until
    // a read warms them.
    for (const table of rebuilt.filter((t) => READ_PATH_CACHES[t.table])) {
      expect(table.rows).toEqual([]);
    }
  });

  test("the write path performs no outbound fetch", async () => {
    // P5: materialisation is a function of the log, so the live write path must
    // not reach the network. A join by an author with no profile row is what
    // used to make `sendEvents` look the author up in HappyView/Bluesky; the
    // spy refuses the request and records it, so a regression fails here rather
    // than in production.
    const author = UserDid.assert("did:plc:purity-network-freedom");
    _resetProfileNegativeCache();

    const realFetch = globalThis.fetch;
    const calls: string[] = [];
    const prevNodeEnv = process.env.NODE_ENV;
    // The profile pipeline skips its appview leg under `bun test`. That
    // suppression belongs to the test runner, not to materialisation, so lift
    // it for this assertion.
    delete process.env.NODE_ENV;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push(url);
      return Promise.reject(
        new Error(`outbound request during a write: ${url}`),
      );
    }) as typeof globalThis.fetch;
    try {
      const sm = new StreamManager(router, {
        appserverUrl: "https://appserver.example",
      });
      await sm.sendEvents(
        streamDid,
        [
          {
            id: newUlid(),
            $type: "space.roomy.space.joinSpace.v0",
          } as unknown as Event,
        ],
        author,
      );
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNodeEnv;
    }
  });
});
