/**
 * E2E test for the `room_activity` projection.
 *
 * The projection replaces a per-board read that scanned EVERY message in every
 * room in scope to pick one per room. Its maintenance rides the per-event
 * transaction the materialiser already opens, so the thing that can silently
 * break is not the read — it is the WRITE: an event that moves a room's latest
 * message without the projection following it.
 *
 * These tests therefore drive the REAL write path (`sendEvents` → materialize →
 * projection maintenance) and then read the board the way a client does,
 * asserting that the projected read equals what the scan returns for the same
 * fixture. Equality is the contract: the projection is an optimisation, so any
 * difference is a bug in one of them.
 *
 * Run: bun test --cwd packages/appserver src/e2e/roomActivityProjection.test.ts
 */

import { describe, expect, test } from "bun:test";
import { newUlid } from "@roomy-space/sdk";
import {
  startAppserver,
  seedSpace,
  seedJoinedSpace,
  seedRoom,
  seedMembership,
  spaceDb,
  type E2eContext,
} from "./helpers.ts";
import { fetchRoomActivity } from "../queries/threadActivity.ts";
import { readRoomActivityProjection } from "../queries/roomActivityProjection.ts";
import { openSpaceDb } from "../db/db.ts";

const USER = "did:plc:room-activity-e2e-user";
const SPACE = "did:web:space-room-activity-e2e.example";
const CHANNEL = newUlid();
const THREAD = newUlid();
const QUIET = newUlid();

/**
 * A createMessage carrying an explicit canonical timestamp.
 *
 * Two `newUlid()` calls in the same millisecond do not order by creation — ULID
 * random suffixes decide, so "the second message is the newest" is not a fact
 * about the events. An explicit `timestampOverride` (the same extension the
 * Discord bridge uses for bridged messages) makes the fixture's ordering
 * deterministic, and exercises the canonical-timestamp path the projection
 * stores rather than inventing a separate one.
 */
function createMessageEvent(roomId: string, text: string, timestamp: number) {
  return {
    id: newUlid(),
    $type: "space.roomy.message.createMessage.v0",
    room: roomId,
    body: {
      mimeType: "text/plain",
      data: { $bytes: Buffer.from(text).toString("base64") },
    },
    extensions: {
      "space.roomy.extension.timestampOverride.v0": {
        $type: "space.roomy.extension.timestampOverride.v0",
        timestamp,
      },
    },
  };
}

/** A distinct, increasing canonical time per message. */
let nextTs = Date.UTC(2026, 0, 1);
const nextTimestamp = () => (nextTs += 1000);

async function sendEvents(ctx: E2eContext, events: unknown[]): Promise<Response> {
  return ctx.authedFetch(USER)(`${ctx.baseUrl}/xrpc/space.roomy.space.sendEvents`, {
    method: "POST",
    body: JSON.stringify({ spaceId: SPACE, events }),
  });
}

/**
 * A space with a channel, a thread linked to it, and a second channel that
 * stays empty — the case whose projection row no message event can create.
 */
async function fixture(): Promise<E2eContext> {
  const ctx = await startAppserver();
  seedSpace(ctx.db, SPACE, USER, { allowPublicJoin: 1 });
  seedJoinedSpace(ctx.db, USER, SPACE);
  // Moves are an admin operation (`writeAuth`), so the fixture's caller needs
  // the admin edge as well as membership.
  seedMembership(ctx.db, SPACE, USER, "admin");
  seedRoom(ctx.db, CHANNEL, SPACE, "general");
  seedRoom(ctx.db, QUIET, SPACE, "quiet");
  seedRoom(ctx.db, THREAD, SPACE, "space.roomy.thread");
  // Canonical parent link, as `link.createRoomLink` materialises it.
  spaceDb(ctx.db, SPACE).run(
    `insert or ignore into edges (head, tail, label, payload)
       values (?, ?, 'link', json_object('canonical_parent', 1))`,
    [CHANNEL, THREAD],
  );
  return ctx;
}

/** The board's own read path, over the per-space DB. */
function readBoard(ctx: E2eContext, roomIds: string[]) {
  return fetchRoomActivity(openSpaceDb(SPACE), roomIds);
}

const asJson = (m: Map<string, unknown>) =>
  JSON.parse(
    JSON.stringify([...m.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))),
  );

describe("room_activity projection", () => {
  test("a live message is reflected by the board read, matching the scan", async () => {
    const ctx = await fixture();

    const res = await sendEvents(ctx, [
      createMessageEvent(CHANNEL, "first", nextTimestamp()),
      createMessageEvent(CHANNEL, "second", nextTimestamp()),
    ]);
    expect(res.status).toBe(200);

    // The write path maintained the projection: no read, no warm, no scan.
    const projected = await readRoomActivityProjection(openSpaceDb(SPACE), [CHANNEL]);
    expect(projected).not.toBeNull();
    expect(projected!.get(CHANNEL)!.latestAt).not.toBeNull();

    const board = await readBoard(ctx, [CHANNEL, THREAD, QUIET]);
    expect(board.get(CHANNEL)!.latestMessage!.content).toBe("second");
    expect(board.get(CHANNEL)!.latestMembers.map((m) => m.did)).toEqual([USER]);
    // A thread with no messages and an empty channel both read as no activity,
    // and the empty channel's row is created by the read's warm.
    expect(board.get(THREAD)!.latestTimestamp).toBeNull();
    expect(board.get(QUIET)!.latestTimestamp).toBeNull();

    // Every room on the page is now projected, so no board read pays the scan.
    expect(
      await readRoomActivityProjection(openSpaceDb(SPACE), [CHANNEL, THREAD, QUIET]),
    ).not.toBeNull();
  }, { timeout: 30000 });

  test("a delete through the write path drops the deleted message from the board", async () => {
    const ctx = await fixture();

    const older = createMessageEvent(CHANNEL, "older", nextTimestamp());
    const newest = createMessageEvent(CHANNEL, "newest", nextTimestamp());
    expect((await sendEvents(ctx, [older, newest])).status).toBe(200);

    const board = await readBoard(ctx, [CHANNEL]);
    expect(board.get(CHANNEL)!.latestMessage!.content).toBe("newest");

    // Delete the newest message: the projection is invalidated by the delete's
    // maintenance step and rebuilt from the rows that remain.
    const del = await sendEvents(ctx, [
      {
        id: newUlid(),
        $type: "space.roomy.message.deleteMessage.v0",
        room: CHANNEL,
        messageId: newest.id,
        extensions: {},
      },
    ]);
    expect(del.status).toBe(200);

    const after = await readBoard(ctx, [CHANNEL]);
    expect(after.get(CHANNEL)!.latestMessage!.content).toBe("older");
    expect(after.get(CHANNEL)!.latestMessage!.id).toBe(older.id);
  }, { timeout: 30000 });

  test("a move through the write path updates both rooms", async () => {
    const ctx = await fixture();

    const moved = createMessageEvent(CHANNEL, "to be moved", nextTimestamp());
    const staying = createMessageEvent(CHANNEL, "staying", nextTimestamp());
    expect((await sendEvents(ctx, [moved, staying])).status).toBe(200);

    const move = await sendEvents(ctx, [
      {
        id: newUlid(),
        $type: "space.roomy.message.moveMessages.v0",
        room: CHANNEL,
        toRoomId: QUIET,
        messageIds: [moved.id],
        extensions: {},
      },
    ]);
    expect(move.status).toBe(200);

    // The destination gained the message; the source kept its remaining one and
    // must not still report the moved message as its latest.
    const board = await readBoard(ctx, [CHANNEL, QUIET]);
    expect(board.get(QUIET)!.latestMessage!.content).toBe("to be moved");
    expect(board.get(CHANNEL)!.latestMessage!.content).toBe("staying");
    expect(board.get(CHANNEL)!.latestMembers.map((m) => m.did)).toEqual([USER]);
  }, { timeout: 30000 });

  test("the projected board equals the scan after a mixed event sequence", async () => {
    const ctx = await fixture();

    const a = createMessageEvent(CHANNEL, "one", nextTimestamp());
    const b = createMessageEvent(CHANNEL, "two", nextTimestamp());
    const c = createMessageEvent(THREAD, "thread message", nextTimestamp());
    expect((await sendEvents(ctx, [a, b, c])).status).toBe(200);
    expect(
      (
        await sendEvents(ctx, [
          {
            id: newUlid(),
            $type: "space.roomy.message.deleteMessage.v0",
            room: CHANNEL,
            messageId: b.id,
            extensions: {},
          },
        ])
      ).status,
    ).toBe(200);

    const rooms = [CHANNEL, THREAD, QUIET];
    const projected = await readBoard(ctx, rooms);
    expect(await readRoomActivityProjection(openSpaceDb(SPACE), rooms)).not.toBeNull();

    // Force the scan by clearing the projection, then compare: the two paths
    // must agree on a fixture that has seen creates, a delete, a thread, and an
    // empty room.
    await openSpaceDb(SPACE).run("delete from room_activity");
    const scanned = await readBoard(ctx, rooms);
    expect(asJson(projected)).toEqual(asJson(scanned));
  }, { timeout: 30000 });
});
