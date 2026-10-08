/**
 * The space list's cache eviction scope, end to end.
 *
 * `space.getSpaces` is a per-caller query: its response lists the spaces that
 * caller joined, and its params name no space at all. A room-shaped change
 * therefore cannot be matched to a cached list by param subset — the question
 * is whether the list CONTAINS the space whose room changed, and only the body
 * can answer it.
 *
 * Getting that wrong is invisible in a unit test of either side, so this drives
 * the real write path and asserts both directions:
 *
 *   - a room change in space A still evicts A's readers (no stale list), and
 *   - it leaves a reader who is not in A alone (no over-eviction).
 *
 * Over-eviction is the failure that matters: it is silent, it costs a handler
 * run per reader per room event, and `invalidateSpace` is reached by every
 * message in every room, so it was the difference between a cache that served
 * the list and one that rebuilt it for everyone on every write.
 */

import { describe, expect, test } from "bun:test";
import { newUlid } from "@roomy-space/sdk";
import {
  globalDb,
  materializeSpace,
  seedReadPosition,
  startAppserver,
  type E2eContext,
} from "./helpers.ts";

const SPACE_A = "did:plc:list-scope-space-a";
const SPACE_B = "did:plc:list-scope-space-b";
const SPACE_C = "did:plc:list-scope-space-c";
/** In both spaces, so A's list holds A and B's list holds B. */
const USER_IN_BOTH = "did:plc:list-scope-both";
/** In B only — a room change in A cannot move any number their list reports. */
const USER_IN_B_ONLY = "did:plc:list-scope-b-only";
/** In C only — unrelated to A's federation with B. */
const USER_IN_C = "did:plc:list-scope-c-only";

/** Read getSpaces for `user`, reporting whether it came from the cache. */
async function readSpaces(
  ctx: E2eContext,
  user: string,
): Promise<{ cached: boolean; spaces: Array<{ id: string; name?: string; hasUnreads: boolean }> }> {
  const cache = ctx.handle.queryCache!;
  const hitsBefore = cache.stats.hits;
  const res = await ctx.authedFetch(user)(`${ctx.baseUrl}/xrpc/space.roomy.space.getSpaces`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    spaces: Array<{ id: string; name?: string; hasUnreads: boolean }>;
  };
  return { cached: cache.stats.hits > hitsBefore, spaces: body.spaces };
}

/** Warm `user`'s list and confirm it is genuinely cached. */
async function warm(ctx: E2eContext, user: string): Promise<void> {
  await readSpaces(ctx, user);
  expect((await readSpaces(ctx, user)).cached).toBe(true);
}

async function createRoom(ctx: E2eContext, spaceId: string, user: string, name: string): Promise<void> {
  const res = await ctx.authedFetch(user)(`${ctx.baseUrl}/xrpc/space.roomy.space.sendEvents`, {
    method: "POST",
    body: JSON.stringify({
      spaceId,
      events: [
        { id: newUlid(), $type: "space.roomy.room.createRoom.v0", kind: "space.roomy.channel", name },
      ],
    }),
  });
  if (res.status !== 200) throw new Error(`createRoom ${res.status}: ${await res.text()}`);
}

describe("getSpaces cache eviction is scoped to the callers whose list the space is in", () => {
  test("a room created in one space evicts its readers' lists and no one else's", async () => {
    const ctx = await startAppserver();
    await materializeSpace(ctx, SPACE_A, USER_IN_BOTH, { roomName: "a-general" });
    await materializeSpace(ctx, SPACE_B, USER_IN_BOTH, { roomName: "b-general" });
    await materializeSpace(ctx, SPACE_B, USER_IN_B_ONLY, { roomName: "b-general" });

    await warm(ctx, USER_IN_BOTH);
    await warm(ctx, USER_IN_B_ONLY);

    await createRoom(ctx, SPACE_A, USER_IN_BOTH, "a-new-channel");

    // The reader whose list holds A must re-read: their badge counts can move
    // with A's rooms.
    expect((await readSpaces(ctx, USER_IN_BOTH)).cached).toBe(false);
    // The reader in B only did not change — their list must survive. Before
    // the fix the signal carried no space at all, which evicted every caller.
    expect((await readSpaces(ctx, USER_IN_B_ONLY)).cached).toBe(true);
  });

  test("the list re-read after an eviction reflects the change (no stale body)", async () => {
    const ctx = await startAppserver();
    await materializeSpace(ctx, SPACE_A, USER_IN_BOTH, { roomName: "a-general" });

    const before = await readSpaces(ctx, USER_IN_BOTH);
    expect(before.spaces.find((s) => s.id === SPACE_A)?.name).not.toBe("renamed-space");

    // A space rename is the caller-scoped case: the name renders on the space's
    // row in every member's list, so every reader is evicted.
    const res = await ctx.authedFetch(USER_IN_BOTH)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.sendEvents`,
      {
        method: "POST",
        body: JSON.stringify({
          spaceId: SPACE_A,
          events: [
            { id: newUlid(), $type: "space.roomy.space.updateSpaceInfo.v0", name: "renamed-space" },
          ],
        }),
      },
    );
    expect(res.status).toBe(200);

    const after = await readSpaces(ctx, USER_IN_BOTH);
    expect(after.cached).toBe(false);
    expect(after.spaces.find((s) => s.id === SPACE_A)?.name).toBe("renamed-space");
  });

  test("getSpaces evictions track the number of lists the space is in, not the number of writes", async () => {
    const ctx = await startAppserver();
    await materializeSpace(ctx, SPACE_B, USER_IN_B_ONLY, { roomName: "b-general" });
    const readersInA = [USER_IN_BOTH, "did:plc:list-scope-a2", "did:plc:list-scope-a3"];
    for (const reader of readersInA) {
      await materializeSpace(ctx, SPACE_A, reader, { roomName: "a-general" });
      await warm(ctx, reader);
    }
    await warm(ctx, USER_IN_B_ONLY);

    const cache = ctx.handle.queryCache!;
    const evictionsBefore = cache.stats.byNsid["space.roomy.space.getSpaces"]?.evictions ?? 0;

    for (let i = 0; i < 5; i++) {
      await createRoom(ctx, SPACE_A, USER_IN_BOTH, `a-churn-${i}`);
    }
    const evictions = (cache.stats.byNsid["space.roomy.space.getSpaces"]?.evictions ?? 0) - evictionsBefore;

    // Three readers hold A, so five room events evict at most 3 entries — not
    // one per event, and nothing at all for the reader in B alone.
    expect(evictions).toBeLessThanOrEqual(readersInA.length);
    expect((await readSpaces(ctx, USER_IN_B_ONLY)).cached).toBe(true);
  });

  test("a space rename evicts that space's readers, not every caller", async () => {
    const ctx = await startAppserver();
    await materializeSpace(ctx, SPACE_A, USER_IN_BOTH, { roomName: "a-general" });
    await materializeSpace(ctx, SPACE_B, USER_IN_B_ONLY, { roomName: "b-general" });

    await warm(ctx, USER_IN_BOTH);
    await warm(ctx, USER_IN_B_ONLY);

    // A rename renders on A's row in every A member's list; B's list has no
    // such row, so nothing it reports can have moved. A signal that reached
    // every caller would drop B's entry too — one wasted handler run per
    // rename per reader who cannot see the space.
    const res = await ctx.authedFetch(USER_IN_BOTH)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.sendEvents`,
      {
        method: "POST",
        body: JSON.stringify({
          spaceId: SPACE_A,
          events: [
            { id: newUlid(), $type: "space.roomy.space.updateSpaceInfo.v0", name: "renamed" },
          ],
        }),
      },
    );
    expect(res.status).toBe(200);

    expect((await readSpaces(ctx, USER_IN_BOTH)).cached).toBe(false);
    expect((await readSpaces(ctx, USER_IN_B_ONLY)).cached).toBe(true);
  });

  test("a message in a federated room evicts the receiving space's readers only", async () => {
    const ctx = await startAppserver();
    const { roomId } = await materializeSpace(ctx, SPACE_A, USER_IN_BOTH, {
      roomName: "a-general",
    });
    // Space B receives A's channel; C is unrelated to the federation.
    await materializeSpace(ctx, SPACE_B, USER_IN_B_ONLY, { roomName: "b-general" });
    await materializeSpace(ctx, SPACE_C, USER_IN_C, { roomName: "c-general" });

    await globalDb(ctx.db)
      .run(
        `insert into space_federations
           (space_id, federating_space_did, status, requested_by_did)
         values (?, ?, 'active', ?)`,
        [SPACE_A, SPACE_B, USER_IN_BOTH],
      );
    await globalDb(ctx.db)
      .run(
        `insert into federation_room_permissions (space_id, federating_space_did, room_id, permission)
         values (?, ?, ?, 'readwrite')`,
        [SPACE_A, SPACE_B, roomId],
      );
    // The receiving-space invalidation only fires when the room has a reader
    // with a read position (it rides the per-user unread diff).
    seedReadPosition(ctx.db, USER_IN_BOTH, roomId, "0", 1);

    await warm(ctx, USER_IN_BOTH);
    await warm(ctx, USER_IN_B_ONLY);
    await warm(ctx, USER_IN_C);

    const res = await ctx.authedFetch(USER_IN_BOTH)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.sendEvents`,
      {
        method: "POST",
        body: JSON.stringify({
          spaceId: SPACE_A,
          events: [
            {
              id: newUlid(),
              $type: "space.roomy.message.createMessage.v0",
              room: roomId,
              body: { mimeType: "text/plain", data: { $bytes: "aGVsbG8=" } },
              extensions: {},
            },
          ],
        }),
      },
    );
    expect(res.status).toBe(200);

    // B's list renders the federated row, so it is stale. C's list never held
    // the receiving space and must survive; before the signal named it, this
    // path emitted an empty param set and swept every cached list.
    expect((await readSpaces(ctx, USER_IN_B_ONLY)).cached).toBe(false);
    expect((await readSpaces(ctx, USER_IN_C)).cached).toBe(true);
  });
});
