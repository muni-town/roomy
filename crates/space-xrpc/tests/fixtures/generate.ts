/**
 * Regenerate the response-parity fixture.
 *
 * Seeds one space through the appserver's test factory (the e2e seed helpers),
 * asks the real TS handlers for every endpoint as three callers, and writes:
 *
 *   - `space.sqlite`   — the per-space DB the Rust worker reads
 *   - `global.sqlite`  — the gateway's global store replica (profiles, link
 *                        cards, space handles)
 *   - `expected.json`  — one case per (endpoint, caller, params): the caller,
 *                        the read-position header the gateway would send, the
 *                        HTTP status, and the exact response body
 *
 * Run from the appserver package so the workspace dependencies resolve:
 *
 *   cd packages/appserver
 *   bun run ../../crates/space-xrpc/tests/fixtures/generate.ts
 *
 * Only the fixture changes; the appserver is untouched.
 */

import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";

import { createAppserver } from "../../../../packages/appserver/src/appserver.ts";
import { testAuthVerifier } from "../../../../packages/appserver/src/xrpc/auth.ts";
import { _resetRateLimit } from "../../../../packages/appserver/src/xrpc/rateLimit.ts";
import {
  closeDb,
  openDb,
  openGlobalDb,
  openReadStateDb,
  openSpaceDb,
} from "../../../../packages/appserver/src/db/db.ts";
import type { AsyncDatabase } from "../../../../packages/appserver/src/db/asyncDatabase.ts";
import {
  globalDb,
  readStateDb,
  seedActivityItem,
  seedMembership,
  seedMessage,
  seedRoom,
  seedSpace,
  seedUser,
  spaceDb,
} from "../../../../packages/appserver/src/e2e/helpers.ts";
import {
  _resetProfileStoreCache,
  _setTestGetProfiles,
} from "../../../../packages/appserver/src/queries/profileStore.ts";
import { _setTestFetchBlockRecords } from "../../../../packages/appserver/src/materialization/blocks.ts";
import { _resetBlockCaches } from "../../../../packages/appserver/src/queries/userBlocks.ts";
import { _setTestGetRoomyProfileRecord } from "../../../../packages/appserver/src/materialization/roomyProfile.ts";

const HERE = new URL(".", import.meta.url).pathname;

/** The tile both corpora attach: one address, so the read and write fixtures agree. */
const TILE_URI = "at://did:plc:ewvi7nxzyoun6zhxrhs64oiz/ing.dasl.masl/3ktile";

// ─── ULIDs (Crockford base32, timestamp prefix) ──────────────────────────
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * The instant every seeded row and ULID is stamped with. Fixed, so re-running
 * this script regenerates byte-identical files: a fixture whose ids and
 * timestamps moved between runs could not be compared with a recorded digest.
 */
const BASE_TIME = 1_700_000_000_000;

/** A counter, so the 16 random characters of a ULID are the same every run. */
let ulidCounter = 0;

function ulid(at: number): string {
  let time = "";
  let n = at;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[n % 32] + time;
    n = Math.floor(n / 32);
  }
  let random = "";
  let value = ++ulidCounter;
  for (let i = 0; i < 16; i++) {
    random = ALPHABET[value % 32] + random;
    value = Math.floor(value / 32);
  }
  return time + random;
}

const SPACE = "did:web:space.example";
const ADMIN = "did:plc:admin";
const MEMBER = "did:plc:member";
const OUTSIDER = "did:plc:outsider";
const BANNED = "did:plc:banned";
const AUTHOR1 = "did:plc:authorone";
const AUTHOR2 = "did:plc:authortwo";
/** An admin of the space who holds no member edge. */
const EXTERNAL_ADMIN = "did:plc:externaladmin";

/**
 * Peer spaces in the federation registry: `PEER` has a pending request into
 * the fixture space, `ACTIVE_PEER` is federated from it, and
 * `REJECTED_ORIGIN` / `INCOMING_ORIGIN` federate into it.
 */
const PEER = "did:web:peer.example";
const ACTIVE_PEER = "did:web:activepeer.example";
const REJECTED_ORIGIN = "did:web:rejected.example";
const INCOMING_ORIGIN = "did:web:incoming.example";
const PEER_ADMIN = "did:plc:peeradmin";
const ACTIVE_PEER_ADMIN = "did:plc:activepeeradmin";
const REJECTED_ORIGIN_ADMIN = "did:plc:rejectedadmin";
const INCOMING_ORIGIN_ADMIN = "did:plc:incomingadmin";

/** Bridge-token grantors; the third granted its token to another space. */
const GRANTOR_ONE = "did:plc:grantorone";
const GRANTOR_TWO = "did:plc:grantortwo";
const GRANTOR_THREE = "did:plc:grantorthree";

/** A ULID no seeded entity carries: a room the log never created. */
const ABSENT_ROOM = "01JRZ0R0000000000000000000";
/** A space DID the node has never materialised. */
const ABSENT_SPACE = "did:web:absent.example";

interface SeedIds {
  m1: string;
  m2: string;
  m4: string;
  t2: string;
  deletedMessageId: string;
}

interface WirePosition {
  roomId: string;
  seenUpTo: string;
  lastActiveAt?: number;
}

interface Case {
  name: string;
  nsid: string;
  params: Record<string, string>;
  caller: string | null;
  readPositions: WirePosition[];
  status: number;
  body: string;
}

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), "space-xrpc-fixture-"));
  process.env.DATA_DIR = dataDir;
  process.env.APPSERVER_QUERY_CACHE_ENABLED = "false";

  _resetProfileStoreCache();
  _resetBlockCaches();
  _setTestGetProfiles(async () => []);
  _setTestFetchBlockRecords(async () => []);
  _setTestGetRoomyProfileRecord(async () => null);

  closeDb();
  // The e2e seed helpers take the routed handle cast to bun:sqlite's
  // `Database`, exactly as `src/e2e/helpers.ts` documents for its callers.
  const db = openDb({
    path: join(dataDir, "roomy-events.sqlite"),
  }) as unknown as Database;

  const handle = await createAppserver({
    authVerifier: testAuthVerifier,
    port: 0,
    dbPath: join(dataDir, "roomy-events.sqlite"),
    quiet: true,
    disableBackgroundWorkers: true,
    disableQueryCache: true,
    happyView: null,
    arbiter: null,
    liveKit: null,
  });
  const base = `http://localhost:${handle.port}`;

  try {
    const ids = await seed(db);
    const cases = await capture(base, ids);
    // The seed helpers leave the clock columns to the schema default, which is
    // the wall clock at generation time. Stamp them with the fixture's own
    // instant so the files the script writes are the same every run.
    const spaceDbHandle = openSpaceDb(SPACE);
    const globalDbHandle = openGlobalDb();
    const readStateDbHandle = openReadStateDb();
    await freezeClockColumns(spaceDbHandle);
    await freezeClockColumns(globalDbHandle);
    await freezeClockColumns(readStateDbHandle);
    // The DBs run in WAL mode: fold the log into the main file so the copied
    // fixture is self-contained, and leave no write-ahead log beside it.
    for (const fixtureDb of [spaceDbHandle, globalDbHandle, readStateDbHandle]) {
      await fixtureDb.run("pragma wal_checkpoint(truncate)");
      await fixtureDb.run("pragma journal_mode(delete)");
    }
    cpSync(
      join(dataDir, "spaces", `${SPACE}.sqlite`),
      join(HERE, "space.sqlite"),
    );
    cpSync(join(dataDir, "global.sqlite"), join(HERE, "global.sqlite"));
    // The caller-owned state the gateway serves from its replica: watermarks,
    // thread activity, and the bridge-token grants a space holds.
    cpSync(
      join(dataDir, "roomy-readstate.sqlite"),
      join(HERE, "readstate.sqlite"),
    );
    writeFileSync(
      join(HERE, "expected.json"),
      JSON.stringify(
        {
          space: SPACE,
          facts: {
            channelId: C1,
            threadId: T1,
            deletedMessageId: ids.deletedMessageId,
            editedMessageId: ids.m2,
            reactedMessageId: ids.m1,
          },
          cases,
        },
        null,
        2,
      ) + "\n",
    );
    // The write corpus runs last: it mutates the space's log and its projection,
    // so the read fixtures are already copied from the pre-write state.
    const writes = await captureWrites(base, db, ids);
    const ingestFixtures = join(HERE, "..", "..", "..", "roomy-ingest", "tests", "fixtures");
    mkdirSync(ingestFixtures, { recursive: true });
    cpSync(join(HERE, "space.sqlite"), join(ingestFixtures, "space.sqlite"));
    cpSync(join(HERE, "global.sqlite"), join(ingestFixtures, "global.sqlite"));
    writeFileSync(
      join(ingestFixtures, "writes.json"),
      JSON.stringify({ space: SPACE, cases: writes }, null, 2) + "\n",
    );

    console.log(`wrote ${cases.length} read cases and ${writes.length} write cases`);
  } finally {
    await handle.close();
    closeDb();
  }
}

// ─── Seed ────────────────────────────────────────────────────────────────

const C1 = "01JC0000000000000000000C01";
const C2 = "01JC0000000000000000000C02";
const C3 = "01JC0000000000000000000C03";
const T1 = "01JC0000000000000000000T01";

async function seed(db: Database): Promise<SeedIds> {
  const base = BASE_TIME;

  seedSpace(db, SPACE, ADMIN, { allowPublicJoin: 0 });
  seedMembership(db, SPACE, MEMBER, "member");
  // A banned caller: a member whom the space has banned, so the matrix has a
  // caller whose access is denied by a row rather than by absence.
  seedMembership(db, SPACE, BANNED, "member");
  await spaceDb(db, SPACE).run(
    "insert into comp_bans (entity, user_did, created_at) values (?, ?, 1)",
    [SPACE, BANNED],
  );
  await spaceDb(db, SPACE).run(
    "insert or ignore into edges (head, tail, label) values (?, ?, 'admin')",
    [SPACE, ADMIN],
  );
  // An admin with no member edge: `getMembers` reports it as an external
  // admin rather than a member.
  seedMembership(db, SPACE, EXTERNAL_ADMIN, "admin");

  for (const did of [AUTHOR1, AUTHOR2, MEMBER, OUTSIDER]) {
    await spaceDb(db, SPACE).run(
      "insert or ignore into entities (id, stream_id) values (?, ?)",
      [did, did],
    );
  }

  seedUser(db, ADMIN, "admin.example.com");
  seedUser(db, MEMBER, "member.example.com");
  seedUser(db, AUTHOR1, "author1.example.com");
  seedUser(db, AUTHOR2, "author2.example.com");
  seedUser(db, OUTSIDER, "outsider.example.com");
  seedUser(db, EXTERNAL_ADMIN, "externaladmin.example.com");
  seedUser(db, PEER_ADMIN, "peeradmin.example.com");
  // Display names/avatars, which the read path overlays on the per-space rows.
  const profiles: Array<[string, string | null, string | null]> = [
    [ADMIN, "Admin", null],
    [MEMBER, "Member", null],
    [AUTHOR1, "Author One", "at://avatar/author1"],
    [AUTHOR2, null, null],
    [OUTSIDER, "Outsider", null],
    [EXTERNAL_ADMIN, "External Admin", null],
    [PEER_ADMIN, "Peer Admin", null],
  ];
  for (const [did, name, avatar] of profiles) {
    await globalDb(db).run(
      "update profiles set name = ?, avatar = ?, updated_at = ? where did = ?",
      [name, avatar, BASE_TIME, did],
    );
  }

  seedRoom(db, C1, SPACE);
  seedRoom(db, C2, SPACE);
  seedRoom(db, C3, SPACE);
  seedRoom(db, T1, SPACE, "space.roomy.thread");
  await spaceDb(db, SPACE).run(
    "update comp_room set default_access = 'none' where entity = ?",
    [C2],
  );
  await spaceDb(db, SPACE).run(
    "update comp_room set default_access = 'read' where entity = ?",
    [C3],
  );
  const roomNames: Array<[string, string]> = [
    [C1, "general"],
    [C2, "secret"],
    [C3, "readonly"],
    [T1, "Thread One"],
  ];
  for (const [room, name] of roomNames) {
    await spaceDb(db, SPACE).run(
      "insert into comp_info (entity, name) values (?, ?)",
      [room, name],
    );
  }
  await spaceDb(db, SPACE).run(
    "insert into edges (head, tail, label, payload) values (?, ?, 'link', ?)",
    [C1, T1, JSON.stringify({ canonical_parent: 1 })],
  );

  const sidebar = JSON.stringify({
    categories: [{ id: "cat1", name: "Category", children: [C1] }],
  });
  await spaceDb(db, SPACE).run(
    "update comp_space set sidebar_config = ? where entity = ?",
    [sidebar, SPACE],
  );

  // Messages. m3 is deleted; m2 is edited; m4 replies to m1.
  interface SeedMessage {
    id: string;
    room: string;
    author: string;
    sort: string;
    ts: number;
  }
  const messages: SeedMessage[] = [];
  const textByMessage = new Map<string, string>();
  const add = (
    room: string,
    author: string,
    offset: number,
    text: string,
  ): string => {
    const sort = ulid(base + offset);
    messages.push({
      id: sort,
      room,
      author,
      sort,
      ts: base + offset,
    });
    textByMessage.set(sort, text);
    return sort;
  };

  const m1 = add(C1, AUTHOR1, 1, "one");
  const m2 = add(C1, AUTHOR1, 2, "two edited");
  const m3 = add(C1, AUTHOR2, 3, "three");
  const m4 = add(C1, AUTHOR2, 4, "four");
  add(C1, AUTHOR1, 5, "five");
  add(C1, AUTHOR2, 6, "six");
  add(C1, AUTHOR1, 7, "seven");
  const secretMessage = add(C2, AUTHOR1, 21, "secret");
  const readonlyMessage = add(C3, AUTHOR2, 31, "readonly message");
  const t1 = add(T1, AUTHOR1, 11, "thread one");
  const t2 = add(T1, AUTHOR2, 12, "thread two");

  for (const message of messages) {
    seedMessage(db, message.id, message.room, SPACE, message.sort);
    const lastEdit = message.id === m2 ? ulid(base + 2 + 500) : message.id;
    await spaceDb(db, SPACE).run(
      `update comp_content
          set mime_type = 'text/markdown', data = ?, timestamp = ?, last_edit = ?
        where entity = ?`,
      [
        new TextEncoder().encode(textByMessage.get(message.id) ?? ""),
        message.ts,
        lastEdit,
        message.id,
      ],
    );
    await spaceDb(db, SPACE).run(
      "insert into edges (head, tail, label) values (?, ?, 'author')",
      [message.id, message.author],
    );
  }

  // Deleted message: the row is gone, so it is not in the page.
  await spaceDb(db, SPACE).run("delete from entities where id = ?", [m3]);

  // Reply context.
  await spaceDb(db, SPACE).run(
    "insert into edges (head, tail, label) values (?, ?, 'reply')",
    [m4, m1],
  );

  // Reactions, in creation order.
  const reactions: Array<[string, string, string, number]> = [
    [m1, MEMBER, "👍", 1],
    [m1, AUTHOR2, "❤️", 2],
    [m2, ADMIN, "👍", 3],
  ];
  for (const [messageId, user, emoji, created] of reactions) {
    await spaceDb(db, SPACE).run(
      `insert into comp_reaction (entity, user, reaction_id, reaction, created_at)
       values (?, ?, ?, ?, ?)`,
      [messageId, user, ulid(base + 100 + created), emoji, created],
    );
  }

  // An image attachment on m1.
  const image = ulid(base + 200);
  await spaceDb(db, SPACE).run(
    "insert into entities (id, stream_id, room) values (?, ?, ?)",
    [image, SPACE, m1],
  );
  await spaceDb(db, SPACE).run(
    `insert into comp_embed_image (entity, mime_type, size, width, height, alt)
     values (?, 'image/png', 1234, 64, 48, 'a picture')`,
    [image],
  );

  // A Web Tile on m2, beside the link: its entity key carries the message
  // suffix like every other embed row's, `tile_uri` keeps the bare address the
  // client's parser takes, and `data` is the payload as stored.
  const tileUri = TILE_URI;
  const tileEntity = `${tileUri}?message=${m2}`;
  await spaceDb(db, SPACE).run(
    "insert into entities (id, stream_id, room) values (?, ?, ?)",
    [tileEntity, SPACE, m2],
  );
  await spaceDb(db, SPACE).run(
    "insert into comp_embed_tile (entity, tile_uri, data) values (?, ?, ?)",
    [tileEntity, tileUri, JSON.stringify({ title: "A tile", rows: [1, 2] })],
  );

  // A link on m2, plus its attachment-encoded duplicate.
  const linkUrl = "https://example.com/a";
  for (const url of [linkUrl, `${linkUrl}?message=${m2}`]) {
    await spaceDb(db, SPACE).run(
      "insert into entities (id, stream_id, room) values (?, ?, ?)",
      [url, SPACE, m2],
    );
    await spaceDb(db, SPACE).run(
      "insert into comp_embed_link (entity) values (?)",
      [url],
    );
  }
  await globalDb(db).run(
    `insert into link_embeds (url, embed_json, attempts, fetched_at)
     values (?, ?, 0, ?)`,
    [
      linkUrl,
      JSON.stringify({
        $type: "space.roomy.embed.link.v0",
        uri: linkUrl,
        title: "Example",
        description: "An example card",
      }),
      BASE_TIME,
    ],
  );

  // Two more space-wide links: one in a channel every member can read and one
  // in the channel whose default access is `none`, so the space index has more
  // than a page and proves it filters by room access.
  const readonlyLink = "https://example.com/readonly";
  const secretLink = "https://example.com/secret";
  for (const [url, messageId] of [
    [readonlyLink, readonlyMessage],
    [secretLink, secretMessage],
  ] as Array<[string, string]>) {
    await spaceDb(db, SPACE).run(
      "insert into entities (id, stream_id, room) values (?, ?, ?)",
      [url, SPACE, messageId],
    );
    await spaceDb(db, SPACE).run(
      "insert into comp_embed_link (entity) values (?)",
      [url],
    );
  }
  await globalDb(db).run(
    `insert into link_embeds (url, embed_json, attempts, fetched_at)
     values (?, ?, 0, ?)`,
    [
      readonlyLink,
      JSON.stringify({
        $type: "space.roomy.embed.link.v0",
        uri: readonlyLink,
        title: "Read Only Guide",
      }),
      BASE_TIME,
    ],
  );

  // Roles: one carrying every optional field and two room grants, one bare
  // (its optional columns are null), and one soft-deleted so the list proves
  // the deleted rows are omitted.
  const moderatorsRole = ulid(base + 300);
  const quietRole = ulid(base + 301);
  const deletedRole = ulid(base + 302);
  const roleRows: Array<
    [string, string | null, string | null, string | null, number]
  > = [
    [moderatorsRole, "Moderators", "at://role/moderators", "Keeps the peace", 0],
    [quietRole, null, null, null, 0],
    [deletedRole, "Retired", null, null, 1],
  ];
  for (const [id, name, avatar, description, deleted] of roleRows) {
    await spaceDb(db, SPACE).run(
      `insert into roles (id, stream_id, name, avatar, description, deleted)
       values (?, ?, ?, ?, ?, ?)`,
      [id, SPACE, name, avatar, description, deleted],
    );
  }
  const roleRooms: Array<[string, string, string]> = [
    [moderatorsRole, C1, "readwrite"],
    [moderatorsRole, C3, "read"],
    [quietRole, C1, "read"],
  ];
  for (const [role, room, permission] of roleRooms) {
    await spaceDb(db, SPACE).run(
      `insert into role_rooms (role_id, room_id, stream_id, permission)
       values (?, ?, ?, ?)`,
      [role, room, SPACE, permission],
    );
  }
  // The member holds the moderators role; the admin holds the bare one.
  for (const [user, role] of [
    [MEMBER, moderatorsRole],
    [ADMIN, quietRole],
  ]) {
    await spaceDb(db, SPACE).run(
      "insert into member_roles (user_id, role_id, stream_id) values (?, ?, ?)",
      [user, role, SPACE],
    );
  }

  // Invite tokens: one minted by an admin, one by a member. A member's list
  // shows only the token they minted; an admin's shows both.
  const invites: Array<[string, string, number]> = [
    ["invite-admin-1", ADMIN, base + 310],
    ["invite-member-1", MEMBER, base + 311],
  ];
  for (const [token, creator, at] of invites) {
    await spaceDb(db, SPACE).run(
      `insert into comp_invite (entity, token, created_by_did, event_ulid)
       values (?, ?, ?, ?)`,
      [SPACE, token, creator, ulid(at)],
    );
  }

  // A live call generation on `general` with one participant. A worker with
  // LiveKit unconfigured reports no calls at all, so the captured voice reads
  // show the unconfigured answer while these rows keep the projection's shape
  // populated.
  const callId = ulid(base + 400);
  await spaceDb(db, SPACE).run(
    `insert into active_calls (room_id, call_id, started_at, source)
     values (?, ?, ?, 'user')`,
    [C1, callId, base + 400],
  );
  await spaceDb(db, SPACE).run(
    `insert into call_participants (room_id, did, call_id, joined_at, source)
     values (?, ?, ?, ?, 'user')`,
    [C1, MEMBER, callId, base + 401],
  );

  // Board ordering.
  seedActivityItem(db, C1, SPACE, base + 40);
  seedActivityItem(db, T1, SPACE, base + 35);
  seedActivityItem(db, C3, SPACE, base + 30);
  seedActivityItem(db, C2, SPACE, base + 25);

  // Read state. Rows exist for the rooms each caller can read; the thread's
  // row marks it engaged (the gateway turns that into `lastActiveAt`).
  const watermarks: Record<string, Array<[string, string]>> = {
    [ADMIN]: [
      [C1, m4],
      [C2, "0"],
      [C3, "0"],
      [T1, t1],
    ],
    [MEMBER]: [
      [C1, m2],
      [C3, "0"],
      [T1, "0"],
    ],
  };
  for (const [user, rooms] of Object.entries(watermarks)) {
    for (const [roomId, seen] of rooms) {
      await readStateDb(db).run(
        `insert or replace into read_positions
           (user_did, room_id, space_did, seen_up_to, updated_at)
         values (?, ?, ?, ?, ?)`,
        [user, roomId, SPACE, seen, BASE_TIME],
      );
    }
  }
  for (const user of [ADMIN, MEMBER]) {
    await readStateDb(db).run(
      `insert or replace into user_thread_activity
         (user_did, thread_id, space_did, last_active_at, updated_at)
       values (?, ?, ?, ?, ?)`,
      [user, T1, SPACE, BASE_TIME - 60 * 60 * 1000, BASE_TIME],
    );
  }

  // Bridge-token grants: two for this space (one live, one spent) and one
  // granted to another space, which this space's list must not show.
  const bridgeGrants: Array<[string, string, number, number | null, number]> = [
    [GRANTOR_ONE, SPACE, base + 500, null, 100],
    [GRANTOR_TWO, SPACE, base + 501, base + 550, 250],
    [GRANTOR_THREE, PEER, base + 502, null, 50],
  ];
  for (const [grantor, space, grantedAt, spentAt, capacity] of bridgeGrants) {
    await readStateDb(db).run(
      `insert or replace into bridge_token_grants
         (grantor_did, space_did, granted_at, spent_at, capacity_snapshot)
       values (?, ?, ?, ?, ?)`,
      [grantor, space, grantedAt, spentAt, capacity],
    );
  }

  // The federation registry (global): relationships where this space is the
  // origin — one pending request, one active federation — and relationships
  // where it is the receiving side — one rejected, one active.
  interface SeedFederation {
    origin: string;
    receiver: string;
    status: string;
    requestedBy: string;
    requestedAt: number;
    message: string | null;
    decidedBy: string | null;
    decidedAt: number | null;
  }
  const federations: SeedFederation[] = [
    {
      origin: SPACE,
      receiver: PEER,
      status: "pending",
      requestedBy: PEER_ADMIN,
      requestedAt: base + 600,
      message: "Could we mirror your channels?",
      decidedBy: null,
      decidedAt: null,
    },
    {
      origin: SPACE,
      receiver: ACTIVE_PEER,
      status: "active",
      requestedBy: ACTIVE_PEER_ADMIN,
      requestedAt: base + 610,
      message: null,
      decidedBy: ADMIN,
      decidedAt: base + 620,
    },
    {
      origin: REJECTED_ORIGIN,
      receiver: SPACE,
      status: "rejected",
      requestedBy: REJECTED_ORIGIN_ADMIN,
      requestedAt: base + 630,
      message: "Please let us in",
      decidedBy: ADMIN,
      decidedAt: base + 640,
    },
    {
      origin: INCOMING_ORIGIN,
      receiver: SPACE,
      status: "active",
      requestedBy: INCOMING_ORIGIN_ADMIN,
      requestedAt: base + 650,
      message: null,
      decidedBy: ADMIN,
      decidedAt: base + 660,
    },
  ];
  for (const federation of federations) {
    await globalDb(db).run(
      `insert into space_federations
         (space_id, federating_space_did, status, requested_by_did,
          requested_at, message, decided_by_did, decided_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        federation.origin,
        federation.receiver,
        federation.status,
        federation.requestedBy,
        federation.requestedAt,
        federation.message,
        federation.decidedBy,
        federation.decidedAt,
      ],
    );
  }
  // Channels shared with the federated peer, plus one on the pending request:
  // a grant on an inactive relationship is inert, so it must not be listed.
  const peerChannel = ulid(base + 700);
  const pendingChannel = ulid(base + 701);
  const originGrants: Array<[string, string, string, string]> = [
    [SPACE, ACTIVE_PEER, C1, "readwrite"],
    [SPACE, ACTIVE_PEER, C3, "read"],
    [SPACE, PEER, pendingChannel, "readwrite"],
  ];
  for (const [origin, receiver, room, permission] of originGrants) {
    await globalDb(db).run(
      `insert into federation_room_permissions
         (space_id, federating_space_did, room_id, permission)
       values (?, ?, ?, ?)`,
      [origin, receiver, room, permission],
    );
  }
  // What this space's admins granted its members on a federated channel of
  // the active incoming origin, plus one on the rejected relationship.
  const incomingChannel = ulid(base + 702);
  const rejectedChannel = ulid(base + 703);
  const receiverGrants: Array<[string, string, string, string, string, string]> = [
    [INCOMING_ORIGIN, SPACE, incomingChannel, SPACE, "members", "read"],
    [INCOMING_ORIGIN, SPACE, incomingChannel, moderatorsRole, "role", "read"],
    [INCOMING_ORIGIN, SPACE, incomingChannel, MEMBER, "user", "readwrite"],
    [REJECTED_ORIGIN, SPACE, rejectedChannel, SPACE, "members", "readwrite"],
  ];
  for (const [origin, receiver, room, grantee, kind, permission] of receiverGrants) {
    await globalDb(db).run(
      `insert into federation_receiver_permissions
         (space_id, federating_space_did, room_id, grantee, kind, permission)
       values (?, ?, ?, ?, ?, ?)`,
      [origin, receiver, room, grantee, kind, permission],
    );
  }

  // Flush every routed worker queue before the handlers read.
  await openSpaceDb(SPACE).query("select 1 as n").get();
  await openGlobalDb().query("select 1 as n").get();
  await openReadStateDb().query("select 1 as n").get();

  return { m1, m2, m4, t2, deletedMessageId: m3 };
}

/**
 * Rewrite every clock column in a database to the fixture's instant.
 *
 * Runs after the seed and before the databases are copied, so a fixture
 * regenerated a month later is byte-identical to this one.
 */
async function freezeClockColumns(db: AsyncDatabase): Promise<void> {
  const tables = await db
    .query(
      `select name from sqlite_master where type = 'table' and name not like 'sqlite_%'`,
    )
    .all<{ name: string }>();
  for (const { name } of tables) {
    const columns = await db
      .query(`select name from pragma_table_info('${name}')`)
      .all<{ name: string }>();
    // `BASE_TIME + rowid` keeps insertion order: a column a read orders by
    // (`comp_reaction.created_at`) still means "written in this order".
    const sets = columns
      .map((column) => column.name)
      .filter((column) => column === "created_at" || column === "updated_at")
      .map((column) => `${column} = ${BASE_TIME} + rowid`);
    if (sets.length === 0) continue;
    await db.run(`update "${name}" set ${sets.join(", ")}`);
  }
}

// ─── Capture ─────────────────────────────────────────────────────────────

const CALLER_NAMES: Record<string, string> = {
  [ADMIN]: "admin",
  [MEMBER]: "member",
  [OUTSIDER]: "outsider",
};

async function readPositions(did: string): Promise<WirePosition[]> {
  const rows = await openReadStateDb()
    .query(
      `select rp.room_id as room_id, rp.seen_up_to as seen_up_to,
              uta.last_active_at as last_active_at
         from read_positions rp
         left join user_thread_activity uta
           on uta.thread_id = rp.room_id and uta.user_did = rp.user_did
        where rp.user_did = ?`,
    )
    .all<{
      room_id: string;
      seen_up_to: string;
      last_active_at: number | null;
    }>(did);
  return rows.map((row) => ({
    roomId: row.room_id,
    seenUpTo: row.seen_up_to,
    ...(row.last_active_at != null ? { lastActiveAt: row.last_active_at } : {}),
  }));
}

async function capture(base: string, ids: SeedIds): Promise<Case[]> {
  const cases: Case[] = [];

  const run = async (
    name: string,
    nsid: string,
    params: Record<string, string>,
    did: string | null,
  ): Promise<string> => {
    // The fixture asks for more requests than one IP's rate-limit window
    // allows. Rate limiting is gateway behaviour, not part of any endpoint's
    // wire contract, so each case is captured against a fresh window rather
    // than recording a 429.
    _resetRateLimit();
    const positions = did ? await readPositions(did) : [];
    const query = new URLSearchParams(params).toString();
    const headers: Record<string, string> = {};
    if (did) headers["X-Test-Did"] = did;
    if (positions.length > 0) {
      headers["x-roomy-read-positions"] = Buffer.from(
        JSON.stringify(positions),
      ).toString("base64url");
    }
    const response = await fetch(`${base}/xrpc/${nsid}?${query}`, { headers });
    const body = await response.text();
    cases.push({
      name,
      nsid,
      params,
      caller: did,
      readPositions: positions,
      status: response.status,
      body,
    });
    return body;
  };

  const endpoints: Array<{
    key: string;
    nsid: string;
    params: Record<string, string>;
  }> = [
    {
      key: "space.getMetadata",
      nsid: "space.roomy.space.getMetadata",
      params: { spaceId: SPACE },
    },
    {
      key: "space.getThreads",
      nsid: "space.roomy.space.getThreads",
      params: { spaceId: SPACE, limit: "2" },
    },
    {
      key: "room.getMetadata.c1",
      nsid: "space.roomy.room.getMetadata",
      params: { roomId: C1 },
    },
    {
      key: "room.getMetadata.thread",
      nsid: "space.roomy.room.getMetadata",
      params: { roomId: T1 },
    },
    {
      key: "room.getMetadata.secret",
      nsid: "space.roomy.room.getMetadata",
      params: { roomId: C2 },
    },
    {
      key: "room.getMessages.c1",
      nsid: "space.roomy.room.getMessages",
      params: { roomId: C1, limit: "2" },
    },
    {
      key: "room.getMessages.thread",
      nsid: "space.roomy.room.getMessages",
      params: { roomId: T1, limit: "2" },
    },
    {
      key: "room.getThreads.c1",
      nsid: "space.roomy.room.getThreads",
      params: { roomId: C1, limit: "1" },
    },
    {
      key: "room.getLinks.c1",
      nsid: "space.roomy.room.getLinks",
      params: { roomId: C1, limit: "1" },
    },
    {
      key: "message.getMessage.edited",
      nsid: "space.roomy.message.getMessage",
      params: { messageId: ids.m2 },
    },
    {
      key: "message.getMessage.reply",
      nsid: "space.roomy.message.getMessage",
      params: { messageId: ids.m4 },
    },
    {
      key: "message.getMessage.thread",
      nsid: "space.roomy.message.getMessage",
      params: { messageId: ids.t2 },
    },
    {
      key: "message.getReactions",
      nsid: "space.roomy.message.getReactions",
      params: { messageId: ids.m1 },
    },
    {
      key: "space.getSpaceSummary",
      nsid: "space.roomy.space.getSpaceSummary",
      params: { spaceId: SPACE },
    },
    {
      key: "space.getLinks",
      nsid: "space.roomy.space.getLinks",
      params: { spaceId: SPACE, limit: "2" },
    },
    {
      key: "space.getMembers",
      nsid: "space.roomy.space.getMembers",
      params: { spaceId: SPACE },
    },
    {
      key: "space.getMembers.search",
      nsid: "space.roomy.space.getMembers",
      params: { spaceId: SPACE, search: "adm" },
    },
    {
      key: "space.getRoles",
      nsid: "space.roomy.space.getRoles",
      params: { spaceId: SPACE },
    },
    {
      key: "space.getInvites",
      nsid: "space.roomy.space.getInvites",
      params: { spaceId: SPACE },
    },
    {
      key: "space.getUserAccess",
      nsid: "space.roomy.space.getUserAccess",
      params: { spaceId: SPACE, userDid: ADMIN },
    },
    {
      key: "space.getBridgeTokens",
      nsid: "space.roomy.space.getBridgeTokens",
      params: { spaceId: SPACE },
    },
    {
      key: "room.getRoomSummary.c1",
      nsid: "space.roomy.room.getRoomSummary",
      params: { roomId: C1 },
    },
    {
      key: "room.getRoomSummary.secret",
      nsid: "space.roomy.room.getRoomSummary",
      params: { roomId: C2 },
    },
    {
      key: "room.getRoomSummary.thread",
      nsid: "space.roomy.room.getRoomSummary",
      params: { roomId: T1 },
    },
    {
      key: "federation.getRequests",
      nsid: "space.roomy.federation.getRequests",
      params: { spaceId: SPACE },
    },
    {
      key: "federation.getIncoming",
      nsid: "space.roomy.federation.getIncoming",
      params: { spaceId: SPACE },
    },
    {
      key: "federation.getOutgoing",
      nsid: "space.roomy.federation.getOutgoing",
      params: { spaceId: SPACE },
    },
    {
      key: "federation.getGrants",
      nsid: "space.roomy.federation.getGrants",
      params: { spaceId: SPACE },
    },
    {
      key: "voice.getParticipants.c1",
      nsid: "space.roomy.voice.getParticipants",
      params: { roomId: C1 },
    },
    {
      key: "voice.getActiveCalls",
      nsid: "space.roomy.voice.getActiveCalls",
      params: { spaceId: SPACE },
    },
    {
      key: "voice.getToken.c1",
      nsid: "space.roomy.voice.getToken",
      params: { roomId: C1 },
    },
    {
      key: "search.rooms.every",
      nsid: "space.roomy.search.rooms",
      params: { spaceId: SPACE, q: "e" },
    },
    {
      key: "search.rooms.readonly",
      nsid: "space.roomy.search.rooms",
      params: { spaceId: SPACE, q: "read" },
    },
  ];

  for (const [did, caller] of Object.entries(CALLER_NAMES)) {
    for (const endpoint of endpoints) {
      await run(`${caller}/${endpoint.key}`, endpoint.nsid, endpoint.params, did);
    }
  }
  for (const endpoint of endpoints.slice(0, 3)) {
    await run(`anonymous/${endpoint.key}`, endpoint.nsid, endpoint.params, null);
  }
  // Endpoints whose answer differs for a caller with no credentials: the two
  // that expose only display fields, and the reads that need a membership.
  for (const endpoint of [
    {
      key: "space.getSpaceSummary",
      nsid: "space.roomy.space.getSpaceSummary",
      params: { spaceId: SPACE },
    },
    {
      key: "space.getLinks",
      nsid: "space.roomy.space.getLinks",
      params: { spaceId: SPACE, limit: "2" },
    },
    {
      key: "space.getUserAccess",
      nsid: "space.roomy.space.getUserAccess",
      params: { spaceId: SPACE, userDid: ADMIN },
    },
    {
      key: "room.getRoomSummary.c1",
      nsid: "space.roomy.room.getRoomSummary",
      params: { roomId: C1 },
    },
    {
      key: "federation.getRequests",
      nsid: "space.roomy.federation.getRequests",
      params: { spaceId: SPACE },
    },
    {
      key: "voice.getParticipants.c1",
      nsid: "space.roomy.voice.getParticipants",
      params: { roomId: C1 },
    },
    {
      key: "voice.getToken.c1",
      nsid: "space.roomy.voice.getToken",
      params: { roomId: C1 },
    },
    {
      key: "search.rooms.every",
      nsid: "space.roomy.search.rooms",
      params: { spaceId: SPACE, q: "e" },
    },
  ]) {
    await run(`anonymous/${endpoint.key}`, endpoint.nsid, endpoint.params, null);
  }

  // The read differential's edges: a caller who is banned, a space, room and
  // message that do not exist, parameters outside every accepted range, and
  // limits at both ends. Each of these is a decision the two implementations
  // have to make the same way, and each is cheap to record.
  await run("banned/space.getMetadata", "space.roomy.space.getMetadata", {
    spaceId: SPACE,
  }, BANNED);
  await run("banned/room.getMessages.c1", "space.roomy.room.getMessages", {
    roomId: C1,
    limit: "2",
  }, BANNED);
  await run("banned/space.getSpaceSummary", "space.roomy.space.getSpaceSummary", {
    spaceId: SPACE,
  }, BANNED);
  await run("banned/space.getMembers", "space.roomy.space.getMembers", {
    spaceId: SPACE,
  }, BANNED);
  await run("banned/search.rooms", "space.roomy.search.rooms", {
    spaceId: SPACE,
    q: "e",
  }, BANNED);

  for (const [key, nsid, params] of [
    ["unknown-space", "space.roomy.space.getMetadata", { spaceId: ABSENT_SPACE }],
    ["unknown-space.summary", "space.roomy.space.getSpaceSummary", { spaceId: ABSENT_SPACE }],
    ["unknown-space.links", "space.roomy.space.getLinks", { spaceId: ABSENT_SPACE }],
    ["unknown-space.members", "space.roomy.space.getMembers", { spaceId: ABSENT_SPACE }],
    ["unknown-space.roles", "space.roomy.space.getRoles", { spaceId: ABSENT_SPACE }],
    ["unknown-space.invites", "space.roomy.space.getInvites", { spaceId: ABSENT_SPACE }],
    ["unknown-space.bridgeTokens", "space.roomy.space.getBridgeTokens", { spaceId: ABSENT_SPACE }],
    ["unknown-space.userAccess", "space.roomy.space.getUserAccess", { spaceId: ABSENT_SPACE, userDid: ADMIN }],
    ["unknown-space.federation", "space.roomy.federation.getRequests", { spaceId: ABSENT_SPACE }],
    ["unknown-space.activeCalls", "space.roomy.voice.getActiveCalls", { spaceId: ABSENT_SPACE }],
    ["unknown-space.searchRooms", "space.roomy.search.rooms", { spaceId: ABSENT_SPACE, q: "e" }],
    ["unknown-room", "space.roomy.room.getMessages", { roomId: ABSENT_ROOM }],
    ["unknown-room.summary", "space.roomy.room.getRoomSummary", { roomId: ABSENT_ROOM }],
    ["unknown-room.participants", "space.roomy.voice.getParticipants", { roomId: ABSENT_ROOM }],
    ["unknown-room.voiceToken", "space.roomy.voice.getToken", { roomId: ABSENT_ROOM }],
    ["unknown-message", "space.roomy.message.getMessage", { messageId: ABSENT_ROOM }],
    ["missing-spaceId", "space.roomy.space.getMetadata", {}],
    ["missing-spaceId.links", "space.roomy.space.getLinks", {}],
    ["missing-spaceId.members", "space.roomy.space.getMembers", {}],
    ["missing-spaceId.roles", "space.roomy.space.getRoles", {}],
    ["missing-spaceId.invites", "space.roomy.space.getInvites", {}],
    ["missing-spaceId.bridgeTokens", "space.roomy.space.getBridgeTokens", {}],
    ["missing-spaceId.userAccess", "space.roomy.space.getUserAccess", { userDid: ADMIN }],
    ["missing-spaceId.federation", "space.roomy.federation.getRequests", {}],
    ["missing-spaceId.activeCalls", "space.roomy.voice.getActiveCalls", {}],
    ["missing-spaceId.searchRooms", "space.roomy.search.rooms", {}],
    ["missing-roomId.summary", "space.roomy.room.getRoomSummary", {}],
    ["missing-roomId.participants", "space.roomy.voice.getParticipants", {}],
    ["missing-roomId.voiceToken", "space.roomy.voice.getToken", {}],
    ["missing-userDid", "space.roomy.space.getUserAccess", { spaceId: SPACE }],
    ["malformed-spaceId", "space.roomy.space.getMetadata", { spaceId: "not-a-did" }],
    ["malformed-spaceId.members", "space.roomy.space.getMembers", { spaceId: "not-a-did" }],
    ["malformed-roomId", "space.roomy.room.getMessages", { roomId: "not-a-ulid" }],
    ["malformed-roomId.summary", "space.roomy.room.getRoomSummary", { roomId: "not-a-ulid" }],
    ["limit-zero", "space.roomy.room.getMessages", { roomId: C1, limit: "0" }],
    ["limit-negative", "space.roomy.room.getMessages", { roomId: C1, limit: "-1" }],
    ["limit-too-large", "space.roomy.room.getMessages", { roomId: C1, limit: "101" }],
    ["limit-not-a-number", "space.roomy.room.getMessages", { roomId: C1, limit: "many" }],
    ["limit-zero.links", "space.roomy.space.getLinks", { spaceId: SPACE, limit: "0" }],
    ["limit-too-large.links", "space.roomy.space.getLinks", { spaceId: SPACE, limit: "101" }],
    ["limit-not-a-number.links", "space.roomy.space.getLinks", { spaceId: SPACE, limit: "many" }],
    ["cursor-garbage", "space.roomy.room.getMessages", { roomId: C1, cursor: "not-a-cursor" }],
    ["cursor-garbage.links", "space.roomy.space.getLinks", { spaceId: SPACE, cursor: "not-a-cursor" }],
    ["search-empty-q", "space.roomy.search.rooms", { spaceId: SPACE, q: "" }],
    ["search-whitespace-q", "space.roomy.search.rooms", { spaceId: SPACE, q: "   " }],
    ["search-no-match", "space.roomy.search.rooms", { spaceId: SPACE, q: "zzz" }],
    ["search-limit-one", "space.roomy.search.rooms", { spaceId: SPACE, q: "e", limit: "1" }],
    ["members-search-no-match", "space.roomy.space.getMembers", { spaceId: SPACE, search: "zzz" }],
    ["no-limit", "space.roomy.space.getThreads", { spaceId: SPACE }],
    ["max-limit", "space.roomy.space.getThreads", { spaceId: SPACE, limit: "100" }],
  ] as Array<[string, string, Record<string, string>]>) {
    await run(`admin/${key}`, nsid, params, ADMIN);
    await run(`outsider/${key}`, nsid, params, OUTSIDER);
  }

  // `getUserAccess` authorises the space's own account, not a person: the
  // request is proxied by the arbiter under the space's DID. The matrix above
  // records the denial every other caller gets, and these record what the
  // space itself is told.
  for (const [key, params] of [
    ["admin", { spaceId: SPACE, userDid: ADMIN }],
    ["member", { spaceId: SPACE, userDid: MEMBER }],
    ["unknown-user", { spaceId: SPACE, userDid: OUTSIDER }],
    ["unknown-space", { spaceId: ABSENT_SPACE, userDid: ADMIN }],
  ] as Array<[string, Record<string, string>]>) {
    await run(
      `space/userAccess.${key}`,
      "space.roomy.space.getUserAccess",
      params,
      SPACE,
    );
  }

  // Pagination walks: the next page is fetched with the cursor the handler
  // returned, for the endpoints that page.
  const paginated: Array<[string, string, Record<string, string>]> = [
    [
      "space.getThreads",
      "space.roomy.space.getThreads",
      { spaceId: SPACE, limit: "2" },
    ],
    [
      "space.getLinks",
      "space.roomy.space.getLinks",
      { spaceId: SPACE, limit: "1" },
    ],
    [
      "room.getMessages.c1",
      "space.roomy.room.getMessages",
      { roomId: C1, limit: "2" },
    ],
    [
      "room.getThreads.c1",
      "space.roomy.room.getThreads",
      { roomId: C1, limit: "1" },
    ],
    [
      "room.getLinks.c1",
      "space.roomy.room.getLinks",
      { roomId: C1, limit: "1" },
    ],
  ];
  for (const did of [ADMIN, MEMBER]) {
    const caller = CALLER_NAMES[did]!;
    for (const [key, nsid, params] of paginated) {
      const body = await run(`${caller}/${key}.page1`, nsid, { ...params }, did);
      const parsed = JSON.parse(body) as { cursor?: string };
      if (!parsed.cursor) continue;
      await run(
        `${caller}/${key}.page2`,
        nsid,
        { ...params, cursor: parsed.cursor },
        did,
      );
    }
  }

  return cases;
}

// ─── The write corpus ────────────────────────────────────────────────────

/**
 * One entry of the write differential: a batch as the client sends it, the
 * response the appserver gave, and the log rows that batch wrote.
 *
 * `order_stamp` encodes the batch instant, which is a wall clock reading on
 * both sides; a comparison drops that prefix and keeps the position it
 * encodes.
 */
interface WriteCase {
  name: string;
  caller: string | null;
  request: unknown;
  status: number;
  body: string;
  events: Array<{
    idx: number;
    user: string;
    eventType: string | null;
    createdAt: number | null;
    receivedAt: number;
  }>;
  changes: Array<{
    idx: number;
    ord: number;
    kind: string;
    repo: string;
    collection: string;
    rkey: string;
    op: string;
    orderStamp: string;
    actor: string;
    eventId: string;
    body: string | null;
  }>;
}

/**
 * The write corpus: every decision `sendEvents` makes, in the order it makes
 * them. The cases are independent by construction — each names a seeded room,
 * message or space, so an earlier case's inline materialisation cannot change
 * a later one's decision — which is what lets the Rust ingress replay them
 * against the read fixture's own database.
 */
async function captureWrites(
  base: string,
  db: Database,
  ids: SeedIds,
): Promise<WriteCase[]> {
  const cases: WriteCase[] = [];
  let lastIdx = -1;

  let eventSeq = 0;
  const event = (kind: string, fields: Record<string, unknown>) => ({
    id: ulid(BASE_TIME + 10_000 + eventSeq++),
    $type: kind,
    extensions: {},
    ...fields,
  });

  const message = (room: string, text: string) =>
    event("space.roomy.message.createMessage.v0", {
      room,
      body: {
        mimeType: "text/plain",
        data: {
          $bytes: Buffer.from(text, "utf8").toString("base64"),
        },
      },
    });

  const run = async (
    name: string,
    caller: string | null,
    request: unknown,
  ): Promise<void> => {
    _resetRateLimit();
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (caller) headers["X-Test-Did"] = caller;
    const response = await fetch(`${base}/xrpc/space.roomy.space.sendEvents`, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
    });
    const body = await response.text();
    const events = await db
      .query(
        `select idx, user, event_type, created_at, received_at
           from stream_events where stream_id = ? and idx > ? order by idx`,
      )
      .all<{
        idx: number;
        user: string;
        event_type: string | null;
        created_at: number | null;
        received_at: number;
      }>(SPACE, lastIdx);
    const changes = await db
      .query(
        `select idx, ord, kind, repo, collection, rkey, op, order_stamp,
                actor, event_id, body
           from record_changes where stream_id = ? and idx > ?
          order by idx, ord`,
      )
      .all<{
        idx: number;
        ord: number;
        kind: string;
        repo: string;
        collection: string;
        rkey: string;
        op: string;
        order_stamp: string;
        actor: string;
        event_id: string;
        body: string | null;
      }>(SPACE, lastIdx);
    for (const row of events) lastIdx = Math.max(lastIdx, row.idx);
    cases.push({
      name,
      caller,
      request,
      status: response.status,
      body,
      events: events.map((row) => ({
        idx: row.idx,
        user: row.user,
        eventType: row.event_type,
        createdAt: row.created_at,
        receivedAt: row.received_at,
      })),
      changes: changes.map((row) => ({
        idx: row.idx,
        ord: row.ord,
        kind: row.kind,
        repo: row.repo,
        collection: row.collection,
        rkey: row.rkey,
        op: row.op,
        orderStamp: row.order_stamp,
        actor: row.actor,
        eventId: row.event_id,
        body: row.body,
      })),
    });
  };

  // Accepted writes: one message, then a batch of two, so the differential
  // sees both the single-entry and the multi-entry append.
  await run("valid.message", MEMBER, {
    spaceId: SPACE,
    events: [message(C1, "hello")],
  });
  await run("valid.batch-of-two", MEMBER, {
    spaceId: SPACE,
    events: [message(C1, "first"), message(C1, "second")],
  });
  await run("valid.reaction", MEMBER, {
    spaceId: SPACE,
    events: [
      event("space.roomy.reaction.addReaction.v0", {
        room: C1,
        reactionTo: ids.m1,
        reaction: "👍",
      }),
    ],
  });
  await run("valid.create-room", ADMIN, {
    spaceId: SPACE,
    events: [
      event("space.roomy.room.createRoom.v0", {
        kind: "space.roomy.channel",
        name: "A new channel",
      }),
    ],
  });

  // Denials, in the order the handler decides them.
  await run("invalid.not-an-object", MEMBER, {
    spaceId: SPACE,
    events: ["not an event"],
  });
  await run("invalid.missing-type", MEMBER, {
    spaceId: SPACE,
    events: [{ id: ulid(BASE_TIME + 20_000) }],
  });
  await run("invalid.unknown-type", MEMBER, {
    spaceId: SPACE,
    events: [event("space.roomy.nope.v0", {})],
  });
  await run("invalid.oversized", MEMBER, {
    spaceId: SPACE,
    events: Array.from({ length: 51 }, (_, index) =>
      message(C1, `overflow ${index}`),
    ),
  });
  await run("invalid.missing-spaceId", MEMBER, {
    events: [message(C1, "no space")],
  });
  await run("invalid.empty-events", MEMBER, { spaceId: SPACE, events: [] });
  await run("unauthorized.outsider", OUTSIDER, {
    spaceId: SPACE,
    events: [message(C1, "outsider")],
  });
  await run("unauthorized.no-write-room", MEMBER, {
    spaceId: SPACE,
    events: [message(C2, "read only")],
  });
  await run("unauthorized.banned", BANNED, {
    spaceId: SPACE,
    events: [message(C1, "banned")],
  });
  await run("unauthorized.create-room", MEMBER, {
    spaceId: SPACE,
    events: [
      event("space.roomy.room.createRoom.v0", {
        kind: "space.roomy.channel",
        name: "Not allowed",
      }),
    ],
  });
  await run("anonymous", null, {
    spaceId: SPACE,
    events: [message(C1, "anonymous")],
  });
  // The same event twice in one batch: the log's key is the position, not the
  // event id, so what the appserver does here is a decision worth recording.
  const repeated = message(C1, "twice");
  await run("duplicate.event-id", MEMBER, {
    spaceId: SPACE,
    events: [repeated, repeated],
  });

  return cases;
}

await main();
