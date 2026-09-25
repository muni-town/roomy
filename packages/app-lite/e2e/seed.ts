/**
 * Seed the appserver for an E2E run.
 *
 * Two halves, matching how the appserver's own HTTP-level e2e tests build a
 * world:
 *
 *  1. **Direct seeding** of the user, space, membership and sidebar config.
 *     `space.roomy.space.createSpace` provisions a `did:plc` through
 *     https://plc.directory, which must not be a CI dependency, so the space
 *     itself is seeded with the appserver's own e2e helpers — the same row
 *     shapes the handlers' SQL expects.
 *
 *  2. **The real write path** for the room and its message: `sendEvents`
 *     over HTTP, exactly as `materializeSpace` does. Materialisation, the
 *     event log, and the read projections all run for real, so the UI reads
 *     genuinely materialised data rather than rows written behind the
 *     materialiser's back.
 *
 * IDs are fixed (not `newUlid()`) so specs can address routes directly.
 *
 * Runs inside the launcher process, which owns the appserver's DB
 * singletons. Not imported by specs.
 */

import type { Database } from "bun:sqlite";
import { serializeBlocks } from "@roomy-space/sdk";
import { openDb } from "../../appserver/src/db/db.ts";
import {
  readStateDb,
  seedJoinedSpace,
  seedMessage,
  seedMembership,
  seedRoom,
  seedSpace,
  seedUser,
  spaceDb,
} from "../../appserver/src/e2e/helpers.ts";
import {
  SEED_MESSAGE_ID,
  SEED_MESSAGE_TEXT,
  SEED_ROOM_ID,
  SEED_ROOM_NAME,
  SEED_SIDEBAR_CATEGORY_ID,
  SEED_SPACE_ID,
  SEED_SPACE_NAME,
  TEST_USER_DID,
  TEST_USER_DISPLAY_NAME,
  TEST_USER_HANDLE,
} from "./fixtures.ts";

/**
 * The sidebar config `getMetadata` reads to build the channel list. The
 * `seedSpace` default is `'{"categories": []}'`, which renders the channel as
 * an orphan; a real config exercises the same branch the product does.
 */
function sidebarConfig(): string {
  return JSON.stringify({
    categories: [
      {
        id: SEED_SIDEBAR_CATEGORY_ID,
        name: "general",
        children: [SEED_ROOM_ID],
      },
    ],
  });
}

/** POST one event batch to `sendEvents` as the test user. */
async function sendEvents(
  origin: string,
  events: Record<string, unknown>[],
): Promise<void> {
  const resp = await fetch(`${origin}/xrpc/space.roomy.space.sendEvents`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Test-Did": TEST_USER_DID,
    },
    body: JSON.stringify({ spaceId: SEED_SPACE_ID, events }),
  });
  if (!resp.ok) {
    throw new Error(
      `seed: sendEvents failed (${resp.status}): ${await resp.text()}`,
    );
  }
}

/**
 * Write the fixture rows. Call after the appserver factory has opened its DB
 * singletons, so `openDb()` here returns the same router the handlers use.
 */
export async function seedFixture(appserverOrigin: string): Promise<void> {
  const router = openDb();
  // The e2e helpers take the SQLite `Database` shape; the router is the same
  // handle they expect (they only reach through it for `forSpace`/`global`/
  // `readState`).
  const db = router as unknown as Database;

  // ── User ─────────────────────────────────────────────────────────────
  // The handle matters: `getProfile` only falls through to a live Bluesky
  // fetch when the row has no usable handle.
  seedUser(db, TEST_USER_DID, TEST_USER_HANDLE);

  // ── Space + membership ───────────────────────────────────────────────
  seedSpace(db, SEED_SPACE_ID, TEST_USER_DID, { allowPublicJoin: 0 });
  // `getSpaces` reads `user_space_membership`; the joinedSpace edge is the
  // global-DB bookkeeping the federation path reads.
  seedJoinedSpace(db, TEST_USER_DID, SEED_SPACE_ID);
  // Admin, so the settings pages render their admin branches.
  seedMembership(db, SEED_SPACE_ID, TEST_USER_DID, "admin");

  const space = spaceDb(db, SEED_SPACE_ID);
  await space.run("update comp_info set name = ?, description = ? where entity = ?", [
    SEED_SPACE_NAME,
    "A space seeded for end-to-end UI tests.",
    SEED_SPACE_ID,
  ]);
  await space.run("update comp_space set sidebar_config = ? where entity = ?", [
    sidebarConfig(),
    SEED_SPACE_ID,
  ]);
  // Author display name, which `selectMessages` reads from comp_info.
  await space.run("update comp_info set name = ? where entity = ?", [
    TEST_USER_DISPLAY_NAME,
    TEST_USER_DID,
  ]);

  // ── Room + message, through the real write path ──────────────────────
  // Two batches: a room created in the same batch as its message is rejected
  // (the destination room must already be materialised).
  await sendEvents(appserverOrigin, [
    {
      id: SEED_ROOM_ID,
      $type: "space.roomy.room.createRoom.v0",
      kind: "space.roomy.channel",
      name: SEED_ROOM_NAME,
    },
  ]);

  const serialized = serializeBlocks([
    { $type: "space.roomy.richtext.blocks#text", text: SEED_MESSAGE_TEXT },
  ]);
  await sendEvents(appserverOrigin, [
    {
      id: SEED_MESSAGE_ID,
      room: SEED_ROOM_ID,
      $type: "space.roomy.message.createMessage.v0",
      body: {
        mimeType: serialized.mimeType,
        data: { $bytes: Buffer.from(serialized.data).toString("base64") },
      },
      extensions: {},
    },
  ]);

  // ── Feature flags ────────────────────────────────────────────────────
  // `search` gates the navbar search UI and the search routes; every flag
  // defaults to off in the appserver.
  await readStateDb(db).run(
    "insert into feature_flags (key, global_enabled) values ('search', 1) on conflict(key) do update set global_enabled = 1",
  );

  // ── Global profile row ───────────────────────────────────────────────
  // `seedUser` writes the handle; the display name is what the sidebar user
  // card and message authors render, and it comes from the global profile
  // store. Seeding it gives specs a distinctive string to assert on, which is
  // what proves the profile round-tripped rather than falling back to a handle.
  await router.global().run("update profiles set name = ? where did = ?", [
    TEST_USER_DISPLAY_NAME,
    TEST_USER_DID,
  ]);

  // Fail loudly here rather than as a confusing empty sidebar in a spec: the
  // space must resolve for this user.
  const membership = await readStateDb(db)
    .query(
      "select count(*) as n from user_space_membership where user_did = ? and space_did = ? and state = 'joined'",
    )
    .get<{ n: number }>(TEST_USER_DID, SEED_SPACE_ID);
  if (!membership || membership.n === 0) {
    throw new Error("seedFixture: membership row missing after seeding");
  }
}

/**
 * Exported only so the launcher can keep the unused-import checker honest
 * about the direct-seed helpers this module deliberately does not use.
 * (`seedRoom` / `seedMessage` are superseded by the real write path above.)
 */
export const unusedDirectSeedHelpers = { seedRoom, seedMessage };
