/**
 * Tests for the `#roomActivityDiff` applicators.
 *
 * These defend the contract that lets the boards stop refetching per message:
 * a diff must reproduce EXACTLY the row a refetch would return, and must say so
 * (return undefined) when it cannot — never approximate, because the caller
 * falls back to invalidating the query on a miss.
 */

import { describe, expect, it } from "vitest";
import type {
  InfiniteData,
  RoomActivityPatch,
  SpaceThreadsData,
  RoomThreadsData,
} from "./roomActivityDiff";
import {
  patchSpaceBoard,
  patchRoomBoard,
  patchSpaceBoardUnread,
  patchRoomBoardUnread,
} from "./roomActivityDiff";

function member(did: string, name: string | null = null) {
  return { did, name, avatar: null };
}

function patch(overrides: Partial<RoomActivityPatch> = {}): RoomActivityPatch {
  return {
    spaceId: "did:web:space.example.com",
    roomId: "01THREAD",
    kind: "thread",
    activity: {
      latestTimestamp: "2026-09-21T10:00:00.000Z",
      latestMembers: [member("did:plc:newcomer", "Newcomer")],
      latestMessage: {
        id: "01MSG",
        content: "hello",
        author: member("did:plc:newcomer", "Newcomer"),
        timestamp: "2026-09-21T10:00:00.000Z",
      },
    },
    ...overrides,
  };
}

/** A room row as the board serves it: older activity, two known members. */
function boardRoom(
  id: string,
  latestTimestamp: string | null,
  members: string[],
): SpaceThreadsData["rooms"][number] {
  return {
    id,
    kind: "thread",
    activity: {
      ...(latestTimestamp ? { latestTimestamp } : {}),
      latestMembers: members.map((d) => member(d)),
    },
  } as SpaceThreadsData["rooms"][number];
}

function spaceBoard(
  rooms: SpaceThreadsData["rooms"],
): InfiniteData<SpaceThreadsData> {
  return { pages: [{ rooms }], pageParams: [undefined] };
}

describe("patchSpaceBoard", () => {
  it("moves the room to the front, keeps the page length, and merges the author into latestMembers", () => {
    const prev = spaceBoard([
      boardRoom("01A", "2026-09-21T09:00:00.000Z", ["did:plc:alice"]),
      boardRoom("01B", "2026-09-21T08:00:00.000Z", ["did:plc:bob"]),
      boardRoom("01THREAD", "2026-09-21T07:00:00.000Z", [
        "did:plc:old1",
        "did:plc:old2",
      ]),
    ]);

    const next = patchSpaceBoard(prev, patch())!;

    // Room moved to front, and the page still holds three rows — the room that
    // was last dropped off, exactly as a refetch of the ordered page would.
    expect(next.pages[0]!.rooms.map((r) => r.id)).toEqual([
      "01THREAD",
      "01A",
      "01B",
    ]);
    const moved = next.pages[0]!.rooms[0]!;
    expect(moved.activity.latestTimestamp).toBe("2026-09-21T10:00:00.000Z");
    expect(moved.activity.latestMessage?.content).toBe("hello");
    // The newcomer leads; the room's previous members follow, capped at 3.
    expect(moved.activity.latestMembers.map((m) => m.did)).toEqual([
      "did:plc:newcomer",
      "did:plc:old1",
      "did:plc:old2",
    ]);
  });

  it("is a miss when the room is not on the cached first page", () => {
    const prev = spaceBoard([
      boardRoom("01A", "2026-09-21T09:00:00.000Z", ["did:plc:alice"]),
    ]);

    // Patching would put the room ahead of rows the client never loaded, and a
    // refetch would instead displace the last row — so the diff refuses.
    expect(patchSpaceBoard(prev, patch())).toBeUndefined();
  });

  it("is a miss when the message does not advance the room's latest activity", () => {
    // A bridged message carrying an old timestampOverride: the board's column
    // is the room's MAX message time, so the room must not move.
    const prev = spaceBoard([
      boardRoom("01THREAD", "2026-09-21T23:00:00.000Z", ["did:plc:alice"]),
      boardRoom("01B", "2026-09-21T08:00:00.000Z", ["did:plc:bob"]),
    ]);

    expect(patchSpaceBoard(prev, patch())).toBeUndefined();
  });

  it("is a miss when nothing is cached for the board", () => {
    expect(patchSpaceBoard(undefined, patch())).toBeUndefined();
  });
});

describe("patchRoomBoard", () => {
  it("moves the thread to the front of its channel's board", () => {
    const prev: InfiniteData<RoomThreadsData> = {
      pages: [
        {
          threads: [
            { id: "01X", activity: { latestTimestamp: "2026-09-21T09:00:00.000Z", latestMembers: [] } },
            { id: "01THREAD", activity: { latestTimestamp: "2026-09-21T07:00:00.000Z", latestMembers: [] } },
          ],
        },
      ],
      pageParams: [undefined],
    };

    const next = patchRoomBoard(prev, patch())!;
    expect(next.pages[0]!.threads.map((t) => t.id)).toEqual([
      "01THREAD",
      "01X",
    ]);
  });

  it("is a miss when the thread is absent", () => {
    const prev: InfiniteData<RoomThreadsData> = {
      pages: [{ threads: [{ id: "01X", activity: { latestMembers: [] } }] }],
      pageParams: [undefined],
    };
    expect(patchRoomBoard(prev, patch())).toBeUndefined();
  });
});

describe("board unread patches (from the per-user #roomMetadataDiff)", () => {
  it("bumps the matching board row's unread count and marks it unread", () => {
    const prev = spaceBoard([
      boardRoom("01A", "2026-09-21T09:00:00.000Z", ["did:plc:alice"]),
      boardRoom("01B", "2026-09-21T08:00:00.000Z", ["did:plc:bob"]),
    ]);
    prev.pages[0]!.rooms[1]!.unreadCount = 2;

    const next = patchSpaceBoardUnread(prev, "01B", 1)!;
    const row = next.pages[0]!.rooms.find((r) => r.id === "01B")!;
    expect(row.unreadCount).toBe(3);
    expect(row.unread).toBe(true);
    // The untouched row keeps its own state.
    expect(next.pages[0]!.rooms[0]!.unreadCount).toBeUndefined();
  });

  it("leaves the row's unread flag alone when the count reaches zero", () => {
    // Clearing is the reader's own updateSeen, which invalidates this query —
    // the frame's recipients are not necessarily looking at the room.
    const prev: InfiniteData<RoomThreadsData> = {
      pages: [
        {
          threads: [
            { id: "01T", unreadCount: 1, unread: true, activity: { latestMembers: [] } },
          ],
        },
      ],
      pageParams: [undefined],
    };

    const next = patchRoomBoardUnread(prev, "01T", -1)!;
    const row = next.pages[0]!.threads[0]!;
    expect(row.unreadCount).toBe(0);
    expect(row.unread).toBe(true);
  });

  it("is a no-op for a board without the room", () => {
    const prev = spaceBoard([boardRoom("01A", null, [])]);
    const next = patchSpaceBoardUnread(prev, "01MISSING", 1)!;
    expect(next.pages[0]!.rooms[0]!.id).toBe("01A");
    expect(next.pages[0]!.rooms[0]!.unreadCount).toBeUndefined();
  });
});
