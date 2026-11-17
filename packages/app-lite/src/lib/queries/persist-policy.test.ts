/**
 * What the persisted cache keeps when a session has rendered reply previews.
 *
 * The snapshot is one count-capped set shared by every query, and a
 * per-message lookup (`space.roomy.message.getMessage`) is created once per
 * rendered reply — the most numerous kind in the cache, and the one whose
 * value is already inside the persisted `room.getMessages` page for its room.
 * These cases seed a realistic session (spaces, room lists, room and space
 * headers, and a reply context per row) and pin the kept set: the lists and
 * headers survive, the per-message duplicates do not.
 *
 * The flag is the object `$lib/queries/message.ts` puts on the reply-context
 * query, imported here rather than restated so both sides read the same
 * value. Written against `node:test` + `node:assert` (app-lite ships no test
 * runner of its own) so the file runs under
 * `node --test --experimental-strip-types`.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { cache } from "@roomy-space/sdk";
import { MESSAGE_QUERY_META } from "./persist-policy.ts";

const { queryKey } = cache;

/**
 * A cache entry as the adapter holds it. `PersistableQuery` is not re-exported
 * from the SDK's root (`index.ts` names only the persister contracts), and the
 * predicate is structural, so the shape is stated here.
 */
interface Query {
  queryKey: readonly unknown[];
  state: {
    status: string;
    data?: unknown;
    dataUpdatedAt?: number;
  };
  meta?: Record<string, unknown>;
}

/** A `getMessages` page as the room view holds it: one row per message. */
function page(roomId: string, count: number) {
  const rows: { id: string; roomId: string }[] = [];
  for (let i = 0; i < count; i++) {
    rows.push({ id: `${roomId}-m${i}`, roomId });
  }
  return rows;
}

/**
 * A session that opened `rooms` rooms and rendered `replies` reply previews
 * per room. `meta` is what the reply-context query carries; omitting it is the
 * unflagged control.
 */
function session(
  rooms: number,
  replies: number,
  meta?: Record<string, unknown>,
): Query[] {
  const queries: Query[] = [
    {
      queryKey: queryKey("space.roomy.space.getSpaces", {}),
      state: { status: "success", data: [{ id: "s1" }], dataUpdatedAt: 1 },
    },
    {
      queryKey: queryKey("space.roomy.space.getMetadata", {}),
      state: { status: "success", data: { name: "space" }, dataUpdatedAt: 1 },
    },
  ];
  for (let r = 0; r < rooms; r++) {
    const roomId = `01ROOM${r}`;
    const messages = page(roomId, 30);
    queries.push(
      {
        queryKey: queryKey("space.roomy.room.getMessages", { roomId }),
        state: { status: "success", data: messages, dataUpdatedAt: 1 },
      },
      {
        queryKey: queryKey("space.roomy.room.getMetadata", { roomId }),
        state: { status: "success", data: { id: roomId }, dataUpdatedAt: 1 },
      },
    );
    // The reply context is seeded from the room list it already holds, so a
    // real entry is success-status and data-bearing — indistinguishable from a
    // fetched one except by its key and its flag.
    for (const message of messages.slice(0, replies)) {
      queries.push({
        queryKey: queryKey("space.roomy.message.getMessage", {
          messageId: message.id,
        }),
        state: { status: "success", data: message, dataUpdatedAt: 1 },
        ...(meta ? { meta } : {}),
      });
    }
  }
  return queries;
}

/** The NSIDs the persisted set keeps, in selection order. */
const keptKinds = (queries: readonly Query[]) =>
  cache.selectPersistableEntries(queries).map((entry) => String(entry.key[0]));

describe("the persisted set — reply contexts do not displace the room lists", () => {
  test("per-message entries are not persisted; room lists and headers are", () => {
    const kinds = keptKinds(session(20, 12, MESSAGE_QUERY_META));

    assert.equal(
      kinds.filter((kind) => kind === "space.roomy.message.getMessage").length,
      0,
      "a reply-context lookup duplicates a row the room list already holds",
    );
    assert.equal(
      kinds.filter((kind) => kind === "space.roomy.room.getMessages").length,
      20,
    );
    assert.equal(
      kinds.filter((kind) => kind === "space.roomy.room.getMetadata").length,
      20,
    );
    assert.equal(
      kinds.filter((kind) => kind === "space.roomy.space.getMetadata").length,
      1,
    );
  });

  test("every persisted key is one the snapshot exists to keep", () => {
    const kinds = keptKinds(session(20, 12, MESSAGE_QUERY_META));
    assert.deepEqual([...new Set(kinds)].sort(), [
      "space.roomy.room.getMessages",
      "space.roomy.room.getMetadata",
      "space.roomy.space.getMetadata",
      "space.roomy.space.getSpaces",
    ]);
    // 20 rooms opened by hand: 20 pages + 20 headers + 2 space-level entries.
    assert.equal(kinds.length, 42);
  });

  test("the exclusion is the flag, not the key or the data", () => {
    const kinds = keptKinds(session(2, 3));
    assert.equal(
      kinds.filter((kind) => kind === "space.roomy.message.getMessage").length,
      6,
      "without the opt-out the same session persists every reply context",
    );
  });

  test("an unrelated meta entry does not opt a query out", () => {
    const kinds = keptKinds(session(1, 2, { source: "reply-context" }));
    assert.equal(
      kinds.filter((kind) => kind === "space.roomy.message.getMessage").length,
      2,
    );
  });
});
