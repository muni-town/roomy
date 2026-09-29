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
 *  2. **The real write path** for the rooms and their messages: `sendEvents`
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
  OTHER_USER_DID,
  OTHER_USER_DISPLAY_NAME,
  OTHER_USER_HANDLE,
  SEED_MEMBER_SPACE_CATEGORY_ID,
  SEED_MEMBER_SPACE_ID,
  SEED_MEMBER_SPACE_MESSAGE_TEXT,
  SEED_MEMBER_SPACE_NAME,
  SEED_MEMBER_SPACE_ROOM_ID,
  SEED_MEMBER_SPACE_ROOM_NAME,
  SEED_MESSAGE_ID,
  SEED_MESSAGE_TEXT,
  SEED_ROOM_2_ID,
  SEED_ROOM_2_MESSAGE_TEXT,
  SEED_ROOM_2_NAME,
  SEED_ROOM_ID,
  SEED_ROOM_NAME,
  SEED_SIDEBAR_CATEGORY_ID,
  SEED_SPACE_2_CATEGORY_ID,
  SEED_SPACE_2_ID,
  SEED_SPACE_2_MESSAGE_TEXT,
  SEED_SPACE_2_NAME,
  SEED_SPACE_2_ROOM_ID,
  SEED_SPACE_2_ROOM_NAME,
  SEED_SPACE_3_CATEGORY_ID,
  SEED_SPACE_3_ID,
  SEED_SPACE_3_MESSAGE_TEXT,
  SEED_SPACE_3_NAME,
  SEED_SPACE_3_ROOM_ID,
  SEED_SPACE_3_ROOM_NAME,
  SEED_SPACE_ID,
  SEED_SPACE_NAME,
  TEST_ADMIN_DID,
  TEST_USER_DID,
  TEST_USER_DISPLAY_NAME,
  TEST_USER_HANDLE,
} from "./fixtures.ts";

/**
 * The sidebar config `getMetadata` reads to build the channel list. The
 * `seedSpace` default is `'{"categories": []}'`, which renders channels as
 * orphans; a real config exercises the same branch the product does.
 */
function sidebarConfig(categoryId: string, roomIds: string[]): string {
  return JSON.stringify({
    categories: [
      {
        id: categoryId,
        name: "general",
        children: roomIds,
      },
    ],
  });
}

/**
 * POST one event batch to `sendEvents` as `callerDid`, defaulting to the
 * seeded user. The member space's rows are written as its admin identity
 * instead: channel creation requires a space admin, and the seeded user is
 * only a member there. Same `sendEvents` path, a different caller — exactly
 * the distinction the appserver's own auth draws.
 */
async function sendEvents(
  origin: string,
  spaceId: string,
  events: Record<string, unknown>[],
  callerDid: string = TEST_USER_DID,
): Promise<void> {
  const resp = await fetch(`${origin}/xrpc/space.roomy.space.sendEvents`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Test-Did": callerDid,
    },
    body: JSON.stringify({ spaceId, events }),
  });
  if (!resp.ok) {
    throw new Error(
      `seed: sendEvents failed (${resp.status}): ${await resp.text()}`,
    );
  }
}

/** Create a channel through the real write path. */
async function createRoom(
  origin: string,
  spaceId: string,
  roomId: string,
  name: string,
  callerDid: string = TEST_USER_DID,
): Promise<void> {
  await sendEvents(
    origin,
    spaceId,
    [
      {
        id: roomId,
        $type: "space.roomy.room.createRoom.v0",
        kind: "space.roomy.channel",
        name,
      },
    ],
    callerDid,
  );
}

/** Post one message into an existing channel through the real write path. */
async function createMessage(
  origin: string,
  spaceId: string,
  messageId: string,
  roomId: string,
  text: string,
  callerDid: string = TEST_USER_DID,
): Promise<void> {
  const serialized = serializeBlocks([
    { $type: "space.roomy.richtext.blocks#text", text },
  ]);
  await sendEvents(
    origin,
    spaceId,
    [
      {
        id: messageId,
        room: roomId,
        $type: "space.roomy.message.createMessage.v0",
        body: {
          mimeType: serialized.mimeType,
          data: { $bytes: Buffer.from(serialized.data).toString("base64") },
        },
        extensions: {},
      },
    ],
    callerDid,
  );
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
  seedUser(db, OTHER_USER_DID, OTHER_USER_HANDLE);

  // ── Spaces + memberships ─────────────────────────────────────────────
  for (const [spaceId, spaceName] of [
    [SEED_SPACE_ID, SEED_SPACE_NAME],
    [SEED_SPACE_2_ID, SEED_SPACE_2_NAME],
    [SEED_SPACE_3_ID, SEED_SPACE_3_NAME],
  ] as const) {
    seedSpace(db, spaceId, TEST_USER_DID, { allowPublicJoin: 0 });
    // `getSpaces` reads `user_space_membership`; the joinedSpace edge is the
    // global-DB bookkeeping the federation path reads.
    seedJoinedSpace(db, TEST_USER_DID, spaceId);

    // Admin everywhere except the third space, so it is the one place the test
    // user's moderation powers are absent (the seeded `member` edge from
    // `seedSpace` is what they hold there).
    if (spaceId !== SEED_SPACE_3_ID) {
      seedMembership(db, spaceId, TEST_USER_DID, "admin");
    }

    const space = spaceDb(db, spaceId);
    await space.run(
      "update comp_info set name = ?, description = ? where entity = ?",
      [spaceName, "A space seeded for end-to-end UI tests.", spaceId],
    );
    // Author display name, which `selectMessages` reads from comp_info.
    await space.run("update comp_info set name = ? where entity = ?", [
      TEST_USER_DISPLAY_NAME,
      TEST_USER_DID,
    ]);
  }

  // The third space's admin — the author of its seeded message, and therefore
  // the reason that message is not the test user's to delete.
  seedMembership(db, SEED_SPACE_3_ID, OTHER_USER_DID, "admin");
  await spaceDb(db, SEED_SPACE_3_ID).run(
    "update comp_info set name = ? where entity = ?",
    [OTHER_USER_DISPLAY_NAME, OTHER_USER_DID],
  );

  // ── Member space ─────────────────────────────────────────────────────
  // The caller is a plain member here, and member-created invites are off —
  // the configuration `getInvites` and `createInvite` refuse a non-admin in.
  // A separate space so no admin edge from the other two can apply.
  seedUser(db, TEST_ADMIN_DID);
  seedSpace(db, SEED_MEMBER_SPACE_ID, TEST_USER_DID, { allowPublicJoin: 0 });
  seedJoinedSpace(db, TEST_USER_DID, SEED_MEMBER_SPACE_ID);
  seedMembership(db, SEED_MEMBER_SPACE_ID, TEST_USER_DID, "member");
  // A second identity with admin here, so a spec can authenticate as it and
  // observe the branch that still works. It carries a `member` edge as well
  // as `admin`: an admin edge alone leaves `isMember` false, and the sidebar
  // hides the Invite button (and the Invites settings tab) for a non-member.
  // It is seeded joined for the same reason — the sidebar's space entry comes
  // from `getSpaces`, which reads `user_space_membership` for whichever DID
  // the request authenticates as.
  seedJoinedSpace(db, TEST_ADMIN_DID, SEED_MEMBER_SPACE_ID);
  seedMembership(db, SEED_MEMBER_SPACE_ID, TEST_ADMIN_DID, "member");
  seedMembership(db, SEED_MEMBER_SPACE_ID, TEST_ADMIN_DID, "admin");
  const memberSpace = spaceDb(db, SEED_MEMBER_SPACE_ID);
  await memberSpace.run(
    "update comp_space set allow_member_invites = 0, sidebar_config = ? where entity = ?",
    [sidebarConfig(SEED_MEMBER_SPACE_CATEGORY_ID, [SEED_MEMBER_SPACE_ROOM_ID]), SEED_MEMBER_SPACE_ID],
  );
  await memberSpace.run(
    "update comp_info set name = ?, description = ? where entity = ?",
    [
      SEED_MEMBER_SPACE_NAME,
      "A space seeded for end-to-end UI tests.",
      SEED_MEMBER_SPACE_ID,
    ],
  );
  await memberSpace.run("update comp_info set name = ? where entity = ?", [
    TEST_USER_DISPLAY_NAME,
    TEST_USER_DID,
  ]);

  const space1 = spaceDb(db, SEED_SPACE_ID);
  await space1.run(
    "update comp_space set sidebar_config = ? where entity = ?",
    [sidebarConfig(SEED_SIDEBAR_CATEGORY_ID, [SEED_ROOM_ID, SEED_ROOM_2_ID]), SEED_SPACE_ID],
  );

  const space2 = spaceDb(db, SEED_SPACE_2_ID);
  await space2.run(
    "update comp_space set sidebar_config = ? where entity = ?",
    [sidebarConfig(SEED_SPACE_2_CATEGORY_ID, [SEED_SPACE_2_ROOM_ID]), SEED_SPACE_2_ID],
  );

  await spaceDb(db, SEED_SPACE_3_ID).run(
    "update comp_space set sidebar_config = ? where entity = ?",
    [sidebarConfig(SEED_SPACE_3_CATEGORY_ID, [SEED_SPACE_3_ROOM_ID]), SEED_SPACE_3_ID],
  );

  // ── Rooms + messages, through the real write path ────────────────────
  // Two batches: a room created in the same batch as its message is rejected
  // (the destination room must already be materialised).
  await createRoom(appserverOrigin, SEED_SPACE_ID, SEED_ROOM_ID, SEED_ROOM_NAME);
  await createRoom(appserverOrigin, SEED_SPACE_ID, SEED_ROOM_2_ID, SEED_ROOM_2_NAME);
  await createMessage(
    appserverOrigin,
    SEED_SPACE_ID,
    SEED_MESSAGE_ID,
    SEED_ROOM_ID,
    SEED_MESSAGE_TEXT,
  );
  await createMessage(
    appserverOrigin,
    SEED_SPACE_ID,
    "01M3C8QTVSG74JEG1QBM3STVX2",
    SEED_ROOM_2_ID,
    SEED_ROOM_2_MESSAGE_TEXT,
  );

  await createRoom(
    appserverOrigin,
    SEED_SPACE_2_ID,
    SEED_SPACE_2_ROOM_ID,
    SEED_SPACE_2_ROOM_NAME,
  );
  await createMessage(
    appserverOrigin,
    SEED_SPACE_2_ID,
    "01M3C8QTVSG74JEG1QBM3STVX3",
    SEED_SPACE_2_ROOM_ID,
    SEED_SPACE_2_MESSAGE_TEXT,
  );
  await createRoom(
    appserverOrigin,
    SEED_MEMBER_SPACE_ID,
    SEED_MEMBER_SPACE_ROOM_ID,
    SEED_MEMBER_SPACE_ROOM_NAME,
    TEST_ADMIN_DID,
  );
  await createMessage(
    appserverOrigin,
    SEED_MEMBER_SPACE_ID,
    "01M3C8QTVSG74JEG1QBM3STVX4",
    SEED_MEMBER_SPACE_ROOM_ID,
    SEED_MEMBER_SPACE_MESSAGE_TEXT,
    TEST_ADMIN_DID,
  );

  // The third space's room and message are authored by its admin, so the
  // message is one the test user may read but not delete.
  await createRoom(
    appserverOrigin,
    SEED_SPACE_3_ID,
    SEED_SPACE_3_ROOM_ID,
    SEED_SPACE_3_ROOM_NAME,
    OTHER_USER_DID,
  );
  await createMessage(
    appserverOrigin,
    SEED_SPACE_3_ID,
    "01M3C8QTVSG74JEG1QBM3STVX5",
    SEED_SPACE_3_ROOM_ID,
    SEED_SPACE_3_MESSAGE_TEXT,
    OTHER_USER_DID,
  );

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
  // spaces must resolve for this user.
  for (const spaceId of [
    SEED_SPACE_ID,
    SEED_SPACE_2_ID,
    SEED_SPACE_3_ID,
    SEED_MEMBER_SPACE_ID,
  ]) {
    const membership = await readStateDb(db)
      .query(
        "select count(*) as n from user_space_membership where user_did = ? and space_did = ? and state = 'joined'",
      )
      .get<{ n: number }>(TEST_USER_DID, spaceId);
    if (!membership || membership.n === 0) {
      throw new Error(
        `seedFixture: membership row missing for ${spaceId} after seeding`,
      );
    }
  }
}

/**
 * Exported only so the launcher can keep the unused-import checker honest
 * about the direct-seed helpers this module deliberately does not use.
 * (`seedRoom` / `seedMessage` are superseded by the real write path above.)
 */
export const unusedDirectSeedHelpers = { seedRoom, seedMessage };
