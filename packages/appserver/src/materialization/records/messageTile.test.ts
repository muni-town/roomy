/**
 * A Web Tile attachment through its life on a message.
 *
 * `attachmentStatements` is shared by create and the edit replace branch, so
 * the create arm covers the replace arm — but not the two things around it:
 * the wholesale-replace cleanup has to delete `comp_embed_tile` too, and the
 * link-only preview-toggle fast path must leave a tile alone. A tile that
 * survives only until the next edit is the failure this file exists to catch
 * (`space.roomy.attachment.forward.v0` is the precedent for a kind that a
 * replace loses).
 *
 * Everything goes through `applyBatch`, so both the create and the edit arrive
 * on the path a live write takes.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  type Attachment,
  type Event,
  type StreamIndex,
  StreamDid,
  UserDid,
  newUlid,
} from "@roomy-space/sdk";

import { closeDb, openDb } from "../../db/db.ts";
import { toAsyncDb } from "../../db/syncAdapter.ts";
import type { DbLike } from "../../db/types.ts";
import { applyBatch } from "../applyBatch.ts";
import type { LoggedEvent } from "../types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, "..", "..", "db", "schema-space.sql");
const GLOBAL_SCHEMA_PATH = join(
  __dirname,
  "..",
  "..",
  "db",
  "schema-global.sql",
);

const STREAM = StreamDid.assert("did:web:message-tile.example");
const USER = UserDid.assert("did:plc:tile-path-user");

const TILE = "at://did:plc:ti1e0wner0000000000000/ing.dasl.masl/3kabc";
const OTHER_TILE = "at://did:plc:ti1e0wner0000000000000/ing.dasl.masl/3kdef";
const LINK = "https://example.com/embed";

beforeEach(() => {
  // `applyBatch` opens the read-state DB through the worker.
  closeDb();
  openDb({ path: ":memory:" });
});
afterEach(() => {
  closeDb();
});

/** An in-memory per-space DB with the real schema. */
function freshSpaceDb(): DbLike {
  const raw = new Database(":memory:");
  raw.exec("pragma foreign_keys = on");
  raw.exec(readFileSync(SCHEMA_PATH, "utf8"));
  return toAsyncDb(raw);
}

function freshGlobalDb(): Database {
  const db = new Database(":memory:");
  db.exec("pragma foreign_keys = on");
  db.exec(readFileSync(GLOBAL_SCHEMA_PATH, "utf8"));
  return db;
}

let idx = 0;
function logged(event: Event): LoggedEvent {
  const at = ++idx;
  return {
    event,
    idx: at as StreamIndex,
    user: USER,
    receivedAt: 1_700_000_000_000 + at,
    createdAt: 1_700_000_000_000,
  };
}

function markdown(text: string) {
  return {
    mimeType: "text/markdown",
    data: { $bytes: Buffer.from(text).toString("base64") },
  };
}

function attachments(attachments: Attachment[]) {
  return {
    "space.roomy.extension.attachments.v0": { attachments },
  };
}

/** Apply one event and fail loudly if it did not land. */
async function apply(db: DbLike, globalDb: Database, event: Event) {
  const stats = await applyBatch(
    db,
    STREAM,
    [logged(event)],
    { isBackfill: false },
    toAsyncDb(globalDb),
  );
  expect(stats.failed).toEqual([]);
  expect(stats.applyErrors).toBe(0);
  expect(stats.materializerErrors).toBe(0);
}

async function tileRows(db: DbLike) {
  return db
    .query("select entity, tile_uri, data from comp_embed_tile order by entity")
    .all<{ entity: string; tile_uri: string; data: string | null }>();
}

describe("a Web Tile attachment on a message", () => {
  test("is written by a create, kept by a link-only edit, replaced by a wholesale edit, and removed by a cleared list", async () => {
    const db = freshSpaceDb();
    const globalDb = freshGlobalDb();
    await db.run("insert into entities (id, stream_id) values (?, ?)", [
      STREAM,
      STREAM,
    ]);
    const room = newUlid();
    const message = newUlid();

    // Create, carrying the tile beside a link.
    await apply(db, globalDb, {
      $type: "space.roomy.message.createMessage.v0",
      id: message,
      room,
      body: markdown("a tile and a link"),
      extensions: attachments([
        {
          $type: "space.roomy.attachment.tile.v0",
          uri: TILE,
          data: { rows: [1, 2], title: "hi" },
        },
        {
          $type: "space.roomy.attachment.link.v0",
          uri: LINK,
          showPreview: true,
        },
      ]),
    });

    expect(await tileRows(db)).toEqual([
      {
        entity: `${TILE}?message=${message}`,
        tile_uri: TILE,
        data: JSON.stringify({ rows: [1, 2], title: "hi" }),
      },
    ]);

    // A link-only edit is an embed-preview toggle. It never takes the replace
    // branch, so the tile row must still be there afterwards.
    await apply(db, globalDb, {
      $type: "space.roomy.message.editMessage.v0",
      id: newUlid(),
      room,
      messageId: message,
      body: markdown("a tile and a link"),
      extensions: attachments([
        { $type: "space.roomy.attachment.link.v0", uri: LINK, showPreview: false },
      ]),
    });

    expect(await tileRows(db)).toEqual([
      {
        entity: `${TILE}?message=${message}`,
        tile_uri: TILE,
        data: JSON.stringify({ rows: [1, 2], title: "hi" }),
      },
    ]);

    // A wholesale replacement drops the old set — including the tile — and
    // writes the new one.
    await apply(db, globalDb, {
      $type: "space.roomy.message.editMessage.v0",
      id: newUlid(),
      room,
      messageId: message,
      body: markdown("a different tile"),
      extensions: attachments([
        { $type: "space.roomy.attachment.tile.v0", uri: OTHER_TILE },
      ]),
    });

    expect(await tileRows(db)).toEqual([
      {
        entity: `${OTHER_TILE}?message=${message}`,
        tile_uri: OTHER_TILE,
        data: null,
      },
    ]);

    // An empty list replaces the set with nothing.
    await apply(db, globalDb, {
      $type: "space.roomy.message.editMessage.v0",
      id: newUlid(),
      room,
      messageId: message,
      body: markdown("no attachments"),
      extensions: attachments([]),
    });

    expect(await tileRows(db)).toEqual([]);
    // The tile entity goes with the row: nothing should be left in `entities`
    // pointing at a removed attachment.
    const orphans = await db
      .query("select id from entities where room = ? and id != ?")
      .all<{ id: string }>(message, message);
    expect(orphans).toEqual([]);
  });

  test("an edit that does not mention attachments leaves the tile in place", async () => {
    const db = freshSpaceDb();
    const globalDb = freshGlobalDb();
    await db.run("insert into entities (id, stream_id) values (?, ?)", [
      STREAM,
      STREAM,
    ]);
    const room = newUlid();
    const message = newUlid();

    await apply(db, globalDb, {
      $type: "space.roomy.message.createMessage.v0",
      id: message,
      room,
      body: markdown("a tile"),
      extensions: attachments([
        { $type: "space.roomy.attachment.tile.v0", uri: TILE, data: "x" },
      ]),
    });

    await apply(db, globalDb, {
      $type: "space.roomy.message.editMessage.v0",
      id: newUlid(),
      room,
      messageId: message,
      body: markdown("a tile, reworded"),
    });

    expect(await tileRows(db)).toEqual([
      { entity: `${TILE}?message=${message}`, tile_uri: TILE, data: '"x"' },
    ]);
  });
});
