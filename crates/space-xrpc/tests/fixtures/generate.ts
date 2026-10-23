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

import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";

import { createAppserver } from "../../../../packages/appserver/src/appserver.ts";
import { testAuthVerifier } from "../../../../packages/appserver/src/xrpc/auth.ts";
import {
  closeDb,
  openDb,
  openGlobalDb,
  openReadStateDb,
  openSpaceDb,
} from "../../../../packages/appserver/src/db/db.ts";
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

// ─── ULIDs (Crockford base32, timestamp prefix) ──────────────────────────
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function ulid(at: number): string {
  let time = "";
  let n = at;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[n % 32] + time;
    n = Math.floor(n / 32);
  }
  let random = "";
  for (let i = 0; i < 16; i++) {
    random += ALPHABET[Math.floor(Math.random() * 32)];
  }
  return time + random;
}

const SPACE = "did:web:space.example";
const ADMIN = "did:plc:admin";
const MEMBER = "did:plc:member";
const OUTSIDER = "did:plc:outsider";
const AUTHOR1 = "did:plc:authorone";
const AUTHOR2 = "did:plc:authortwo";

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
    // The DBs run in WAL mode: fold the log into the main file so the copied
    // fixture is self-contained.
    await openSpaceDb(SPACE).run("pragma wal_checkpoint(truncate)");
    await openGlobalDb().run("pragma wal_checkpoint(truncate)");
    // A committed fixture needs no write-ahead log beside it.
    await openSpaceDb(SPACE).run("pragma journal_mode(delete)");
    await openGlobalDb().run("pragma journal_mode(delete)");
    cpSync(
      join(dataDir, "spaces", `${SPACE}.sqlite`),
      join(HERE, "space.sqlite"),
    );
    cpSync(join(dataDir, "global.sqlite"), join(HERE, "global.sqlite"));
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
    console.log(`wrote ${cases.length} cases`);
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
  const base = Date.now() - 10 * 60 * 1000;

  seedSpace(db, SPACE, ADMIN, { allowPublicJoin: 0 });
  seedMembership(db, SPACE, MEMBER, "member");
  await spaceDb(db, SPACE).run(
    "insert or ignore into edges (head, tail, label) values (?, ?, 'admin')",
    [SPACE, ADMIN],
  );

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
  // Display names/avatars, which the read path overlays on the per-space rows.
  const profiles: Array<[string, string | null, string | null]> = [
    [ADMIN, "Admin", null],
    [MEMBER, "Member", null],
    [AUTHOR1, "Author One", "at://avatar/author1"],
    [AUTHOR2, null, null],
    [OUTSIDER, "Outsider", null],
  ];
  for (const [did, name, avatar] of profiles) {
    await globalDb(db).run(
      "update profiles set name = ?, avatar = ?, updated_at = ? where did = ?",
      [name, avatar, Date.now(), did],
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
  add(C2, AUTHOR1, 21, "secret");
  add(C3, AUTHOR2, 31, "readonly message");
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
      Date.now(),
    ],
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
        [user, roomId, SPACE, seen, Date.now()],
      );
    }
  }
  for (const user of [ADMIN, MEMBER]) {
    await readStateDb(db).run(
      `insert or replace into user_thread_activity
         (user_did, thread_id, space_did, last_active_at, updated_at)
       values (?, ?, ?, ?, ?)`,
      [user, T1, SPACE, Date.now() - 60 * 60 * 1000, Date.now()],
    );
  }

  // Flush every routed worker queue before the handlers read.
  await openSpaceDb(SPACE).query("select 1 as n").get();
  await openGlobalDb().query("select 1 as n").get();
  await openReadStateDb().query("select 1 as n").get();

  return { m1, m2, m4, t2, deletedMessageId: m3 };
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
  ];

  for (const [did, caller] of Object.entries(CALLER_NAMES)) {
    for (const endpoint of endpoints) {
      await run(`${caller}/${endpoint.key}`, endpoint.nsid, endpoint.params, did);
    }
  }
  for (const endpoint of endpoints.slice(0, 3)) {
    await run(`anonymous/${endpoint.key}`, endpoint.nsid, endpoint.params, null);
  }

  // Pagination walks: the next page is fetched with the cursor the handler
  // returned, for the four endpoints that page.
  const paginated: Array<[string, string, Record<string, string>]> = [
    [
      "space.getThreads",
      "space.roomy.space.getThreads",
      { spaceId: SPACE, limit: "2" },
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

await main();
