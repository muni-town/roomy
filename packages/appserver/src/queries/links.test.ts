/**
 * Unit tests for the link index aggregation helper (`queries/links.ts`).
 *
 * The critical invariant this guards (per the embed sweeper's warning): a
 * link's `entities.room` is the MESSAGE id, NOT the room id. Resolving the
 * room therefore requires the two-hop join `link.room -> msg.id -> msg.room`.
 * Returning the message id as the room id would make a space/room-scoped link
 * query silently drop every link (or attribute it to the wrong room).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { toAsyncDb } from "../db/syncAdapter.ts";
import type { DbLike } from "../db/types.ts";
import { dedupeLinks, listLinks, cursorForRow } from "./links.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMA_PATH = join(__dirname, "..", "db", "schema-space.sql");

const SPACE = "did:web:space.example";
const ROOM_A = "01ROOMA00000000000000000000".slice(0, 26);
const ROOM_B = "01ROOMB00000000000000000000".slice(0, 26);

function freshDb(): { db: Database; asyncDb: DbLike } {
  const db = new Database(":memory:");
  db.exec("pragma foreign_keys = on");
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  return { db, asyncDb: toAsyncDb(db) };
}

/**
 * Seed a message in a room carrying a link. Mirrors the real materializer:
 * the link entity's `room` = the message id (NOT the room id), and the link
 * entity carries an EMPTY stream_id (see `detectAndStoreLinks`).
 */
function seedLinkMessage(
  db: Database,
  opts: {
    msgId: string;
    roomId: string;
    url: string;
    sortIdx?: string;
    embedJson?: string | null;
    /** When true, also write an enriched embed row. Default: null (no data). */
    enrich?: boolean;
  },
) {
  const { msgId, roomId, url, sortIdx = msgId, enrich = false } = opts;
  db.run("insert or ignore into entities (id, stream_id) values (?, ?)", [roomId, SPACE]);
  db.run(
    "insert into entities (id, stream_id, room, sort_idx) values (?, ?, ?, ?)",
    [msgId, SPACE, roomId, sortIdx],
  );
  // Link entity: room = message id, stream_id = '' (matching materializer).
  db.run("insert into entities (id, stream_id, room) values (?, '', ?)", [
    url,
    msgId,
  ]);
  db.run("insert into comp_embed_link (entity, show_preview) values (?, 1)", [
    url,
  ]);
  if (enrich) {
    db.run(
      "insert into comp_embed_link_data (entity, embed_json) values (?, ?)",
      [url, opts.embedJson ?? JSON.stringify({ t: "Fancy Title" })],
    );
  }
}

describe("listLinks", () => {
  test("resolves the real room id, not the message id (two-hop join)", async () => {
    const { db, asyncDb } = freshDb();
    const msgId = "01MSGA0000000000000000000000".slice(0, 26);
    seedLinkMessage(db, { msgId, roomId: ROOM_A, url: "https://a.example/1" });

    const { links, hasMore } = await listLinks(asyncDb, {
      kind: "room",
      roomId: ROOM_A,
    });
    expect(links).toHaveLength(1);
    expect(links[0]!.room_id).toBe(ROOM_A);
    expect(links[0]!.message_id).toBe(msgId);
    expect(links[0]!.url).toBe("https://a.example/1");
    expect(hasMore).toBe(false);
  });

  test("room scope returns only that room's links", async () => {
    const { db, asyncDb } = freshDb();
    const msgA = "01MSGA0000000000000000000000".slice(0, 26);
    const msgB = "01MSGB0000000000000000000000".slice(0, 26);
    seedLinkMessage(db, { msgId: msgA, roomId: ROOM_A, url: "https://a.example/1" });
    seedLinkMessage(db, { msgId: msgB, roomId: ROOM_B, url: "https://b.example/1" });

    const { links } = await listLinks(asyncDb, { kind: "room", roomId: ROOM_A });
    expect(links.map((l) => l.url)).toEqual(["https://a.example/1"]);
  });

  test("space scope returns links across rooms, filtering on the message stream_id", async () => {
    const { db, asyncDb } = freshDb();
    const msgA = "01MSGA0000000000000000000000".slice(0, 26);
    const msgB = "01MSGB0000000000000000000000".slice(0, 26);
    seedLinkMessage(db, { msgId: msgA, roomId: ROOM_A, url: "https://a.example/1" });
    seedLinkMessage(db, { msgId: msgB, roomId: ROOM_B, url: "https://b.example/1" });

    const { links } = await listLinks(asyncDb, { kind: "space", spaceId: SPACE });
    expect(links).toHaveLength(2);
    // newest-first by sort_idx (msgId ULIDs: B > A lexically/chronologically).
    expect(links[0]!.url).toBe("https://b.example/1");
    expect(links[1]!.url).toBe("https://a.example/1");
  });

  test("orders newest-first by the message sort_idx", async () => {
    const { db, asyncDb } = freshDb();
    const oldMsg = "01MSGA0000000000000000000000".slice(0, 26);
    const newMsg = "01MSGB0000000000000000000000".slice(0, 26);
    seedLinkMessage(db, { msgId: oldMsg, roomId: ROOM_A, url: "https://old.example/1" });
    seedLinkMessage(db, { msgId: newMsg, roomId: ROOM_A, url: "https://new.example/2" });

    const { links } = await listLinks(asyncDb, { kind: "room", roomId: ROOM_A });
    expect(links.map((l) => l.url)).toEqual([
      "https://new.example/2",
      "https://old.example/1",
    ]);
  });

  test("carries the enriched embed when present, null when not", async () => {
    const { db, asyncDb } = freshDb();
    const msgA = "01MSGA0000000000000000000000".slice(0, 26);
    const msgB = "01MSGB0000000000000000000000".slice(0, 26);
    seedLinkMessage(db, { msgId: msgA, roomId: ROOM_A, url: "https://rich.example/1", enrich: true });
    seedLinkMessage(db, { msgId: msgB, roomId: ROOM_A, url: "https://bare.example/2", enrich: false });

    const { links } = await listLinks(asyncDb, { kind: "room", roomId: ROOM_A });
    const rich = links.find((l) => l.url === "https://rich.example/1");
    const bare = links.find((l) => l.url === "https://bare.example/2");
    expect(rich!.embed_json).toContain("Fancy Title");
    expect(bare!.embed_json).toBeNull();
  });

  test("pagination returns hasMore and cursor that resumes from the next page", async () => {
    const { db, asyncDb } = freshDb();
    // Seed three messages in descending chronology so room A holds 3 links.
    const m1 = "01MSGA0000000000000000000000".slice(0, 26);
    const m2 = "01MSGB0000000000000000000000".slice(0, 26);
    const m3 = "01MSGC0000000000000000000000".slice(0, 26);
    seedLinkMessage(db, { msgId: m1, roomId: ROOM_A, url: "https://a.example/1" });
    seedLinkMessage(db, { msgId: m2, roomId: ROOM_A, url: "https://b.example/2" });
    seedLinkMessage(db, { msgId: m3, roomId: ROOM_A, url: "https://c.example/3" });

    const page1 = await listLinks(asyncDb, { kind: "room", roomId: ROOM_A }, 2);
    expect(page1.links).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    // Newest two first.
    expect(page1.links.map((l) => l.url)).toEqual([
      "https://c.example/3",
      "https://b.example/2",
    ]);
    // Cursor is the last visible row's key.
    const cursor = cursorForRow(page1.links[1]);
    expect(cursor).toBe(`${page1.links[1]!.sort_key}::${page1.links[1]!.url}`);

    const page2 = await listLinks(asyncDb, { kind: "room", roomId: ROOM_A }, 2, cursor);
    expect(page2.links).toHaveLength(1);
    expect(page2.links[0]!.url).toBe("https://a.example/1");
    expect(page2.hasMore).toBe(false);
  });
});

describe("dedupeLinks", () => {
  test("keeps the newest occurrence of an attachment-encoded duplicate URL", () => {
    const msgA = "01MSGA0000000000000000000000".slice(0, 26);
    const newer = "01MSGB0000000000000000000000".slice(0, 26);
    // Same canonical URL; the newest row comes first (newest-first input).
    const rows = [
      { url: `https://x.example?a=1&message=${newer}`, room_id: ROOM_A, message_id: newer, sort_key: newer, embed_json: "{}" },
      { url: `https://x.example?a=1&message=${msgA}`, room_id: ROOM_A, message_id: msgA, sort_key: msgA, embed_json: "{}" },
    ];
    const out = dedupeLinks(rows);
    expect(out).toHaveLength(1);
    expect(out[0]!.message_id).toBe(newer);
    expect(out[0]!.url).toBe(`https://x.example?a=1&message=${newer}`);
  });

  test("a body-URL row and an attachment-encoded row of the same URL dedup to one", () => {
    const msgA = "01MSGA0000000000000000000000".slice(0, 26);
    const newer = "01MSGB0000000000000000000000".slice(0, 26);
    const rows = [
      { url: `https://y.example/thing?message=${newer}`, room_id: ROOM_A, message_id: newer, sort_key: newer, embed_json: "{}" },
      { url: `https://y.example/thing`, room_id: ROOM_A, message_id: msgA, sort_key: msgA, embed_json: "{}" },
    ];
    const out = dedupeLinks(rows);
    expect(out).toHaveLength(1);
    expect(out[0]!.message_id).toBe(newer);
  });

  test("distinct URLs are all kept", () => {
    const msgA = "01MSGA0000000000000000000000".slice(0, 26);
    const rows = [
      { url: "https://a.example/1", room_id: ROOM_A, message_id: msgA, sort_key: msgA, embed_json: "{}" },
      { url: "https://b.example/2", room_id: ROOM_A, message_id: msgA, sort_key: msgA, embed_json: "{}" },
    ];
    const out = dedupeLinks(rows);
    expect(out).toHaveLength(2);
  });
});

describe("cursorForRow", () => {
  test("returns null for an undefined/empty row", () => {
    expect(cursorForRow(undefined)).toBeNull();
  });
  test("encodes sort_key :: url", () => {
    const row = {
      url: "https://c.example/3",
      room_id: ROOM_A,
      message_id: "01MSGC0000000000000000000000".slice(0, 26),
      sort_key: "01MSGC0000000000000000000000".slice(0, 26),
      embed_json: null,
    };
    expect(cursorForRow(row)).toBe(`${row.sort_key}::${row.url}`);
  });
});
