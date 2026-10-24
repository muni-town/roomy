/**
 * Tests for the activity feed's per-space fan-out.
 *
 * The feed reads its page, its messages and its embeds from one DB per joined
 * space. These tests pin the two properties of that fan-out that are not
 * visible in the feed's content:
 *
 *   - the answer is unchanged — a multi-space fixture's pages, cursors and
 *     per-space `limit` match what the serial fan-out produced (the expectation
 *     below was captured from it against this exact fixture);
 *   - the spaces are read concurrently, and not all at once.
 *
 * The handle opener is the seam: `_setTestSpaceDbOpener` sees every per-space
 * handle the fan-out takes, so a wrapper can count how many DB calls are in
 * flight and cap-breach without depending on wall-clock timing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { StreamDid, UserDid } from "@roomy-space/sdk";

import { closeDb, openDb, openReadStateDb, openGlobalDb, openSpaceDb } from "../db/db.ts";
import type { DbLike } from "../db/types.ts";
import { _resetProfileNegativeCache } from "../materialization/profiles.ts";
import {
  _setTestSpaceDbOpener,
  SPACE_FANOUT_CONCURRENCY,
  selectActivityFeed,
  type ActivityFeedItem,
} from "./activityFeed.ts";
import { _setTestGetProfiles } from "./profileStore.ts";
import { setUserSpaceMembership } from "./userSpaceMembership.ts";

const USER = "did:plc:alice";
const SPACE_A = "did:web:fanout-a.example";
const SPACE_B = "did:web:fanout-b.example";
const SPACE_C = "did:web:fanout-c.example";

let ulidCounter = 0;

/** A ULID encoding `ts`, so `sort_idx`/`decodeTime` order with the fixture. */
function ulidFor(ts: number): string {
  const chars = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let remaining = ts;
  let encoded = "";
  for (let i = 0; i < 10; i++) {
    encoded = chars[remaining % 32]! + encoded;
    remaining = Math.floor(remaining / 32);
  }
  return encoded + String(ulidCounter++).padStart(16, "0").slice(0, 16);
}

function setup(): DbLike {
  closeDb();
  openDb({ path: ":memory:" });
  _resetProfileNegativeCache();
  // Hermetic: hydration must not reach a live appview.
  _setTestGetProfiles(async () => []);
  return openReadStateDb();
}

async function join(spaceId: string): Promise<void> {
  await setUserSpaceMembership(
    openReadStateDb(),
    USER as UserDid,
    spaceId as StreamDid,
    "joined",
    "test",
    "01TEST0000000000000000000000",
  );
}

/**
 * A space with one room: a channel whose latest message is at `ts` (plus an
 * older one), an `activity_item` pointing at both, and, when `unread` > 0, a
 * read position `unread` messages back.
 */
async function seedRoom(options: {
  spaceId: string;
  roomId: string;
  ts: number;
  deleted?: boolean;
  unread?: number;
  withOlderMessage?: boolean;
}): Promise<void> {
  const { spaceId, roomId, ts, deleted = false, unread = 0, withOlderMessage = false } = options;
  const db = openSpaceDb(spaceId);
  await db.run("insert or ignore into entities (id, stream_id) values (?, ?)", [spaceId, spaceId]);
  await db.run("insert or ignore into entities (id, stream_id) values (?, ?)", [USER, spaceId]);
  await db.run("insert or ignore into comp_space (entity) values (?)", [spaceId]);
  await db.run("insert or ignore into entities (id, stream_id) values (?, ?)", [roomId, spaceId]);
  await db.run(
    "insert into comp_room (entity, label, default_access, deleted) values (?, 'space.roomy.channel', 'readwrite', ?)",
    [roomId, deleted ? 1 : 0],
  );
  await db.run(
    "insert into comp_info (entity, name, avatar) values (?, ?, ?)",
    [roomId, `room ${roomId}`, `${roomId}.png`],
  );

  const ids: string[] = [];
  for (const [offset, content] of [
    [0, `latest in ${roomId}`],
    [-1, `older in ${roomId}`],
  ] as const) {
    if (offset === -1 && !withOlderMessage) continue;
    const id = ulidFor(ts + offset);
    ids.push(id);
    await db.run(
      "insert into entities (id, stream_id, room, sort_idx) values (?, ?, ?, ?)",
      [id, spaceId, roomId, id],
    );
    await db.run(
      "insert into comp_content (entity, mime_type, data, last_edit, timestamp) values (?, 'text/plain', ?, ?, ?)",
      [id, Buffer.from(content), id, ts + offset],
    );
    await db.run("insert into edges (head, tail, label) values (?, ?, 'author')", [id, USER]);
  }

  await db.run(
    `insert into activity_item
       (room_id, space_id, is_thread, last_activity_at, recent_message_ids,
        room_name, space_name, created_at, updated_at)
     values (?, ?, 0, ?, ?, ?, ?, (unixepoch() * 1000), (unixepoch() * 1000))`,
    [
      roomId,
      spaceId,
      ts,
      JSON.stringify(ids.map((id, i) => ({ id, ts: ts - i }))),
      `room ${roomId}`,
      `space ${spaceId}`,
    ],
  );

  if (unread > 0) {
    // The watermark sits on the newest message known *before* the unread ones;
    // the unread messages are posted after it.
    await openReadStateDb().run(
      `insert into read_positions (user_did, room_id, space_did, seen_up_to, updated_at)
       values (?, ?, ?, ?, ?)`,
      [USER, roomId, spaceId, ids[0]!, Date.now()],
    );
    for (let i = 1; i <= unread; i++) {
      const id = ulidFor(ts + i);
      await db.run(
        "insert into entities (id, stream_id, room, sort_idx) values (?, ?, ?, ?)",
        [id, spaceId, roomId, id],
      );
      await db.run(
        "insert into comp_content (entity, mime_type, data, last_edit, timestamp) values (?, 'text/plain', ?, ?, ?)",
        [id, Buffer.from(`unread ${i}`), id, ts + i],
      );
      await db.run("insert into edges (head, tail, label) values (?, ?, 'author')", [id, USER]);
    }
  }
}

/** The multi-space fixture the frozen expectation below was captured against. */
async function seedFixture(): Promise<DbLike> {
  const readState = setup();
  for (const spaceId of [SPACE_A, SPACE_B, SPACE_C]) await join(spaceId);

  await seedRoom({ spaceId: SPACE_A, roomId: "01ROOMA0000000000000000AA", ts: 5_000, unread: 2, withOlderMessage: true });
  await seedRoom({ spaceId: SPACE_A, roomId: "01ROOMA0000000000000000AB", ts: 4_000 });
  await seedRoom({ spaceId: SPACE_B, roomId: "01ROOMB0000000000000000BA", ts: 5_000 });
  await seedRoom({ spaceId: SPACE_B, roomId: "01ROOMB0000000000000000BB", ts: 3_000 });
  await seedRoom({ spaceId: SPACE_C, roomId: "01ROOMC0000000000000000CA", ts: 4_500 });
  // A deleted room's item is filtered before the page is built.
  await seedRoom({ spaceId: SPACE_C, roomId: "01ROOMC0000000000000000CB", ts: 9_000, deleted: true });
  return readState;
}

afterEach(() => {
  _setTestSpaceDbOpener(null);
  _setTestGetProfiles(null);
  closeDb();
});

describe("activity feed per-space fan-out", () => {
  test("pages, ordering, limit and cursors match the serial fan-out", async () => {
    const readState = await seedFixture();

    const pages: Array<{ feed: ActivityFeedItem[]; cursor: string | null }> = [];
    let cursor: string | null = null;
    for (let i = 0; i < 4; i++) {
      const page = await selectActivityFeed(readState, USER, { limit: 2, cursor });
      pages.push({ feed: page.feed, cursor: page.cursor });
      cursor = page.cursor;
      if (cursor === null) break;
    }
    const scoped = await selectActivityFeed(readState, USER, {
      limit: 50,
      cursor: null,
      spaceId: SPACE_C,
    });

    expect({ pages, scoped: { feed: scoped.feed, cursor: scoped.cursor } }).toEqual(
      EXPECTED_PAGES,
    );
  });

  test("reads the spaces concurrently", async () => {
    const readState = await seedFixture();

    const stats = trackInFlight();
    await selectActivityFeed(readState, USER, { limit: 50, cursor: null });

    // A serial fan-out never has more than one call open; the three spaces
    // here are read at once.
    expect(stats.max).toBeGreaterThan(1);
    expect(stats.calls).toBeGreaterThan(1);
  });

  test("opens at most SPACE_FANOUT_CONCURRENCY space DBs at once", async () => {
    const readState = await seedFixture();
    const extra = Array.from({ length: SPACE_FANOUT_CONCURRENCY + 4 }, (_, i) => {
      return `did:web:fanout-extra-${i}.example`;
    });
    for (const spaceId of extra) await join(spaceId);

    const stats = trackInFlight();
    await selectActivityFeed(readState, USER, { limit: 50, cursor: null });

    // More spaces than the bound were in scope, yet the bound held.
    expect(stats.calls).toBeGreaterThan(SPACE_FANOUT_CONCURRENCY);
    expect(stats.max).toBeLessThanOrEqual(SPACE_FANOUT_CONCURRENCY);
    expect(stats.max).toBeGreaterThan(1);
  });
});

/**
 * Route every per-space handle through a wrapper that counts the `all` calls in
 * flight. The counter is updated around the await, so it observes overlap
 * rather than an elapsed time.
 */
function trackInFlight(): { calls: number; max: number } {
  const stats = { calls: 0, max: 0 };
  let live = 0;
  _setTestSpaceDbOpener((spaceDid): DbLike => {
    const db = openSpaceDb(spaceDid);
    return {
      prepare: (sql) => db.prepare(sql),
      exec: (sql) => db.exec(sql),
      run: (sql, ...params) => db.run(sql, ...params),
      transaction: (steps) => db.transaction(steps),
      close: () => db.close(),
      query(sql: string) {
        const inner = db.query(sql);
        return {
          async all<T>(...params: unknown[]): Promise<T[]> {
            stats.calls++;
            live++;
            stats.max = Math.max(stats.max, live);
            try {
              return await inner.all<T>(...params);
            } finally {
              live--;
            }
          },
          get<T>(...params: unknown[]): Promise<T | null> {
            return inner.get<T>(...params);
          },
        };
      },
    };
  });
  return stats;
}

// Captured from the serial fan-out against `seedFixture`, at the commit this
// fan-out replaced. The pages are compared as whole DTOs, so a change to
// ordering, the per-space `limit + 1` page, the cursor, or any hydrated field
// fails here.
const EXPECTED_PAGES: {
  pages: Array<{ feed: ActivityFeedItem[]; cursor: string | null }>;
  scoped: { feed: ActivityFeedItem[]; cursor: string | null };
} = {
  "pages": [
    {
      "feed": [
        {
          "threadId": "01ROOMB0000000000000000BA",
          "spaceId": "did:web:fanout-b.example",
          "lastActivityAt": "1970-01-01T00:00:05.000Z",
          "activityType": "message",
          "messages": [
            {
              "id": "00000004W80000000000000005",
              "content": "latest in 01ROOMB0000000000000000BA",
              "mimeType": "text/plain",
              "author": {
                "did": "did:plc:alice"
              },
              "timestamp": "1970-01-01T00:00:05.000Z"
            }
          ],
          "unreadCount": 0,
          "threadName": "room 01ROOMB0000000000000000BA",
          "spaceName": "space did:web:fanout-b.example"
        },
        {
          "threadId": "01ROOMA0000000000000000AA",
          "spaceId": "did:web:fanout-a.example",
          "lastActivityAt": "1970-01-01T00:00:05.000Z",
          "activityType": "message",
          "messages": [
            {
              "id": "00000004W80000000000000000",
              "content": "latest in 01ROOMA0000000000000000AA",
              "mimeType": "text/plain",
              "author": {
                "did": "did:plc:alice"
              },
              "timestamp": "1970-01-01T00:00:05.000Z"
            },
            {
              "id": "00000004W70000000000000001",
              "content": "older in 01ROOMA0000000000000000AA",
              "mimeType": "text/plain",
              "author": {
                "did": "did:plc:alice"
              },
              "timestamp": "1970-01-01T00:00:04.999Z"
            }
          ],
          "unreadCount": 2,
          "threadName": "room 01ROOMA0000000000000000AA",
          "spaceName": "space did:web:fanout-a.example"
        }
      ],
      "cursor": "5000::01ROOMA0000000000000000AA"
    },
    {
      "feed": [
        {
          "threadId": "01ROOMC0000000000000000CA",
          "spaceId": "did:web:fanout-c.example",
          "lastActivityAt": "1970-01-01T00:00:04.500Z",
          "activityType": "message",
          "messages": [
            {
              "id": "00000004CM0000000000000007",
              "content": "latest in 01ROOMC0000000000000000CA",
              "mimeType": "text/plain",
              "author": {
                "did": "did:plc:alice"
              },
              "timestamp": "1970-01-01T00:00:04.500Z"
            }
          ],
          "unreadCount": 0,
          "threadName": "room 01ROOMC0000000000000000CA",
          "spaceName": "space did:web:fanout-c.example"
        },
        {
          "threadId": "01ROOMA0000000000000000AB",
          "spaceId": "did:web:fanout-a.example",
          "lastActivityAt": "1970-01-01T00:00:04.000Z",
          "activityType": "message",
          "messages": [
            {
              "id": "00000003X00000000000000004",
              "content": "latest in 01ROOMA0000000000000000AB",
              "mimeType": "text/plain",
              "author": {
                "did": "did:plc:alice"
              },
              "timestamp": "1970-01-01T00:00:04.000Z"
            }
          ],
          "unreadCount": 0,
          "threadName": "room 01ROOMA0000000000000000AB",
          "spaceName": "space did:web:fanout-a.example"
        }
      ],
      "cursor": "4000::01ROOMA0000000000000000AB"
    },
    {
      "feed": [
        {
          "threadId": "01ROOMB0000000000000000BB",
          "spaceId": "did:web:fanout-b.example",
          "lastActivityAt": "1970-01-01T00:00:03.000Z",
          "activityType": "message",
          "messages": [
            {
              "id": "00000002XR0000000000000006",
              "content": "latest in 01ROOMB0000000000000000BB",
              "mimeType": "text/plain",
              "author": {
                "did": "did:plc:alice"
              },
              "timestamp": "1970-01-01T00:00:03.000Z"
            }
          ],
          "unreadCount": 0,
          "threadName": "room 01ROOMB0000000000000000BB",
          "spaceName": "space did:web:fanout-b.example"
        }
      ],
      "cursor": null
    }
  ],
  "scoped": {
    "feed": [
      {
        "threadId": "01ROOMC0000000000000000CA",
        "spaceId": "did:web:fanout-c.example",
        "lastActivityAt": "1970-01-01T00:00:04.500Z",
        "activityType": "message",
        "messages": [
          {
            "id": "00000004CM0000000000000007",
            "content": "latest in 01ROOMC0000000000000000CA",
            "mimeType": "text/plain",
            "author": {
              "did": "did:plc:alice"
            },
            "timestamp": "1970-01-01T00:00:04.500Z"
          }
        ],
        "unreadCount": 0,
        "threadName": "room 01ROOMC0000000000000000CA",
        "spaceName": "space did:web:fanout-c.example"
      }
    ],
    "cursor": null
  }
};
