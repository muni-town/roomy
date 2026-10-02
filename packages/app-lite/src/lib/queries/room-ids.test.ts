/**
 * The reply-target guard's decision rule.
 *
 * `getMessage` rejects every entity that is not a message with
 * `400 "is not a message (no room)"`, so a reply preview must not ask about a
 * target the client can already identify as a room. The guard that shipped
 * first only recognised "the target is the room the reply lives in", which
 * missed the targets that are *other* rooms — the shape production actually
 * carried (a lobby reply targeting a thread id). These cases pin the wider
 * rule, so a regression back to the own-room-only comparison fails here.
 *
 * Written against `node:test` + `node:assert` (app-lite ships no test runner of
 * its own) so the file runs under `node --test --experimental-strip-types`.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { collectRoomIds, isNonMessageReplyTarget } from "./room-ids.ts";

const LOBBY = "01KZBRQMEP2FTE079YRVDFKGTA";
const BRAMBLE = "01M2EX4PQYW94DBCX6PJVDDS7X";
const SORREL = "01M2EX4XPG4M15XB03C81M9GF2";
/** A thread of `lobby` — the target shape production carried. */
const LOBBY_THREAD = "01M32SBYQZW0SZSSFJAWKCYQSF";
const MESSAGE = "01M32TJZ0W32QBER5JN9X4JB6D";

/** A `space.roomy.space.getMetadata` response as the sidebar renders it. */
const spaceMetadata = {
  sidebar: {
    categories: [
      {
        name: "GENERAL",
        position: 0,
        channels: [
          {
            id: LOBBY,
            name: "lobby",
            defaultAccess: "readwrite",
            canRead: true,
            canWrite: true,
            unreadCount: 0,
            activeThreads: [
              {
                id: "01M32SC092DNJS14N2H2XYVBJP",
                name: "an active thread",
                canRead: true,
                canWrite: true,
                unreadCount: 0,
                activity: { latestTimestamp: null, latestMembers: [] },
              },
            ],
          },
        ],
      },
    ],
    orphans: [{ id: SORREL, name: "sorrel", defaultAccess: "read", canRead: true, canWrite: false, unreadCount: 0 }],
  },
  deletedRooms: [{ id: "01DELETEDROOM0000000000000", name: "gone" }],
};

/**
 * A `room.getMetadata` response. `recentThreads` is the listing that names a
 * thread the sidebar has already dropped — the one place the failing lobby
 * target is still on the client.
 */
const roomMetadata = {
  kind: "channel",
  spaceId: "did:plc:space",
  defaultAccess: "readwrite",
  canRead: true,
  canWrite: true,
  unreadCount: 0,
  unreadThreadCount: 0,
  recentThreads: [
    { id: LOBBY_THREAD, name: "TASK-179", canRead: true, canWrite: true, unreadCount: 0 },
  ],
};

/** An infinite query's cached data: `{ pages: [...] }`. */
const spaceThreads = {
  pages: [{ rooms: [{ id: "01SPACETHREAD0000000000000", kind: "thread" }] }],
};
const roomThreads = {
  pages: [{ threads: [{ id: "01CHANNELTHREAD00000000000" }] }],
};

const NSIDS = {
  spaceMetadata: "space.roomy.space.getMetadata",
  roomMetadata: "space.roomy.room.getMetadata",
  spaceThreads: "space.roomy.space.getThreads",
  roomThreads: "space.roomy.room.getThreads",
  messages: "space.roomy.room.getMessages",
} as const;

function entry(nsid: string, data: unknown, params?: Record<string, unknown>) {
  return { queryKey: params ? [nsid, params] : [nsid], state: { data } };
}

describe("isNonMessageReplyTarget", () => {
  // The case the first guard covered, kept honest: a reply whose target is the
  // room it lives in needs no cache at all.
  test("a target that IS the reply's own room is not a message", () => {
    assert.equal(
      isNonMessageReplyTarget(BRAMBLE, BRAMBLE, new Set()),
      true,
    );
  });

  // The defect: the target is a room, but not the reply's own. Knowable only
  // from the room listings the client holds — and under the own-room-only
  // comparison this returned false, so the request went out and 400'd.
  test("a target that is ANOTHER room is not a message", () => {
    const ids = collectRoomIds([
      entry(NSIDS.spaceMetadata, spaceMetadata),
    ]);
    assert.equal(isNonMessageReplyTarget(SORREL, LOBBY, ids), true);
  });

  // The exact production shape: a lobby reply whose target is a thread of
  // lobby. The sidebar does not list it; `room.getMetadata.recentThreads` does.
  test("a lobby reply targeting a lobby thread is not a message", () => {
    const ids = collectRoomIds([
      entry(NSIDS.spaceMetadata, spaceMetadata),
      entry(NSIDS.roomMetadata, roomMetadata, { roomId: LOBBY }),
    ]);
    assert.equal(isNonMessageReplyTarget(LOBBY_THREAD, LOBBY, ids), true);
  });

  // …and the same target is unrecognised without that listing, which is why
  // this guard depends on the cache rather than the own-room comparison alone.
  test("a thread target is unknown when no listing names it", () => {
    const ids = collectRoomIds([
      entry(NSIDS.spaceMetadata, spaceMetadata),
      entry(NSIDS.messages, [{ id: MESSAGE, replyTo: LOBBY_THREAD }], {
        roomId: LOBBY,
      }),
    ]);
    assert.equal(isNonMessageReplyTarget(LOBBY_THREAD, LOBBY, ids), false);
  });

  // The guard must never suppress a lookup that could have succeeded.
  test("a real message target is asked about", () => {
    const ids = collectRoomIds([
      entry(NSIDS.spaceMetadata, spaceMetadata),
      entry(NSIDS.roomMetadata, roomMetadata, { roomId: LOBBY }),
      entry(NSIDS.spaceThreads, spaceThreads),
      // The message list holds the message itself; a message id is not a room.
      entry(NSIDS.messages, [{ id: MESSAGE, replyTo: LOBBY_THREAD }], {
        roomId: LOBBY,
      }),
    ]);
    assert.equal(isNonMessageReplyTarget(MESSAGE, LOBBY, ids), false);
  });

  test("an id in no listing at all is still asked about", () => {
    const ids = collectRoomIds([entry(NSIDS.spaceMetadata, spaceMetadata)]);
    assert.equal(isNonMessageReplyTarget("01UNKNOWN000000000000000000", LOBBY, ids), false);
  });

  test("an empty target is not treated as a room", () => {
    assert.equal(isNonMessageReplyTarget("", LOBBY, new Set([""])), false);
  });
});

describe("collectRoomIds", () => {
  test("reads channels, their active threads, and orphans from the sidebar", () => {
    const ids = collectRoomIds([entry(NSIDS.spaceMetadata, spaceMetadata)]);
    assert.equal(ids.has(LOBBY), true);
    assert.equal(ids.has("01M32SC092DNJS14N2H2XYVBJP"), true);
    assert.equal(ids.has(SORREL), true);
  });

  // A deleted room is still a room entity, so a reply targeting one fails the
  // same way; the sidebar lists them for the restore flow.
  test("reads deleted rooms", () => {
    const ids = collectRoomIds([entry(NSIDS.spaceMetadata, spaceMetadata)]);
    assert.equal(ids.has("01DELETEDROOM0000000000000"), true);
  });

  test("reads both board shapes: space rooms and channel threads", () => {
    const ids = collectRoomIds([
      entry(NSIDS.spaceThreads, spaceThreads),
      entry(NSIDS.roomThreads, roomThreads),
    ]);
    assert.equal(ids.has("01SPACETHREAD0000000000000"), true);
    assert.equal(ids.has("01CHANNELTHREAD00000000000"), true);
  });

  // Every query keyed by a room id is a room by construction — including the
  // message list, whose key is the room even though its data is messages.
  test("reads the roomId of every cached key", () => {
    const ids = collectRoomIds([
      entry(NSIDS.messages, [{ id: MESSAGE }], { roomId: BRAMBLE }),
    ]);
    assert.equal(ids.has(BRAMBLE), true);
    assert.equal(ids.has(MESSAGE), false);
  });

  // Payloads are per-NSID responses, so a shape change must narrow the guard
  // back to asking rather than throwing.
  test("an unexpected payload shape yields no ids instead of throwing", () => {
    const ids = collectRoomIds([
      entry(NSIDS.spaceMetadata, null),
      entry(NSIDS.roomMetadata, { recentThreads: "not an array" }, { roomId: LOBBY }),
      entry(NSIDS.spaceThreads, { pages: [{ rooms: [null, 7, { id: 42 }] }] }),
      entry(NSIDS.roomThreads, { pages: null }),
    ]);
    assert.deepEqual([...ids], [LOBBY]);
  });
});
