/**
 * The `message` record path reproduces the event path's projection.
 *
 * One corpus is derived twice — once through the event materialisers, once
 * through the message projection rules — and the two per-space databases are
 * compared with the rebuild-equality oracle's own snapshot and diff. The corpus
 * is the kind's whole surface: a create with every attachment type, a bridged
 * message, a richtext body with a link facet, a legacy forward, an edit that
 * replaces content, an edit that replaces and one that only toggles
 * attachments, a move, and a delete that removes a forward reference with it.
 * A `createRoomLink` runs through it too, so an event that emits a `room` and a
 * `message` is shown to stay wholly on the event path — its message applied
 * once, not twice.
 *
 * `comp_content.last_edit` is the one value the two paths cannot agree on. The
 * column records the identity of the write that last set the content: the event
 * path has the edit event's ULID, and a record change has no event id — its
 * identity is the ordering stamp the adapter carries. The read path compares
 * the value against the message id to tell an edited message from an untouched
 * one, so the stamp serves the same purpose. The comparison below pins that
 * this is the *only* divergence, and that every other row of every table is
 * identical.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  type Event,
  type EventType,
  RICHTEXT_MIME,
  type StreamIndex,
  type Ulid,
  StreamDid,
  UserDid,
  newUlid,
} from "@roomy-space/sdk";

import { closeDb, openDb } from "../../db/db.ts";
import { toAsyncDb } from "../../db/syncAdapter.ts";
import type { DbLike } from "../../db/types.ts";
import {
  type TableSnapshot,
  diffSnapshots,
  digestOf,
  snapshotSpaceDb,
} from "../../streams/rebuildEquality.ts";
import { applyBatch } from "../applyBatch.ts";
import type { LoggedEvent } from "../types.ts";
import { CONVERTED_KINDS, _withEventPath, convertedChanges } from "./toRecordChanges.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, "..", "..", "db", "schema-space.sql");
const GLOBAL_SCHEMA_PATH = join(
  __dirname,
  "..",
  "..",
  "db",
  "schema-global.sql",
);

const STREAM = StreamDid.assert("did:web:message-record-path.example");
const USER = UserDid.assert("did:plc:record-path-user");
/** The author a bridged message is attributed to, whose content it is. */
const BRIDGED = UserDid.assert("did:plc:record-path-bridged");

const RECEIVED_AT = 1_700_000_000_000;

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

/** An in-memory global DB, which the entity→space index routes to. */
function freshGlobalDb(): Database {
  const db = new Database(":memory:");
  db.exec("pragma foreign_keys = on");
  db.exec("pragma journal_mode = wal");
  const schema = readFileSync(GLOBAL_SCHEMA_PATH, "utf8");
  db.exec(schema);
  return db;
}

/** One log entry, with the receipt the append path would have stamped. */
function logged(event: Event, idx: number): LoggedEvent {
  return {
    event,
    idx: idx as StreamIndex,
    user: USER,
    receivedAt: RECEIVED_AT + idx,
    createdAt: RECEIVED_AT,
  };
}

/** A legacy body: markdown, carried as the decoded `{ buf }` the log holds. */
function markdown(text: string) {
  return {
    mimeType: "text/markdown",
    data: { buf: new TextEncoder().encode(text) },
  };
}

/** A new-format body: one text block carrying a `#link` facet. */
function richtext(text: string, url: string) {
  const body = {
    blocks: [
      {
        $type: "space.roomy.richtext.blocks#text",
        text,
        facets: [
          {
            index: { byteStart: 0, byteEnd: Buffer.byteLength(url) },
            features: [
              { $type: "space.roomy.richtext.facet#link", uri: url },
            ],
          },
        ],
      },
    ],
  };
  return {
    mimeType: RICHTEXT_MIME,
    data: { buf: new TextEncoder().encode(JSON.stringify(body)) },
  };
}

/** The ids the corpus refers to. */
interface Corpus {
  channel: Ulid;
  thread: Ulid;
  /** An empty channel a forward lands in, so nothing else writes its row. */
  spare: Ulid;
  /** The system message `createRoomLink` writes; it stays on the event path. */
  linkMessage: Ulid;
  /** Carries every attachment type; the delete at the end removes it. */
  attached: Ulid;
  /** Legacy body with a URL, then an edit, then an attachment replacement. */
  plain: Ulid;
  /** Richtext body with a link facet. */
  rich: Ulid;
  /** Bridged: overridden author and timestamp; later moved. */
  bridged: Ulid;
  /** The page edit a comment attachment's `version` points at. */
  pageEdit: Ulid;
}

function corpus(): { entries: LoggedEvent[]; fx: Corpus } {
  const fx: Corpus = {
    channel: newUlid(),
    thread: newUlid(),
    spare: newUlid(),
    linkMessage: newUlid(),
    attached: newUlid(),
    plain: newUlid(),
    rich: newUlid(),
    bridged: newUlid(),
    pageEdit: newUlid(),
  };

  // The literals are the decoded log form: content bytes are `{ buf }`, which
  // is what the log carries and what `applyBatch` decodes. One cast at the end
  // keeps each event readable.
  const events = [
    {
      $type: "space.roomy.space.updateSpaceInfo.v0",
      id: newUlid(),
      name: "Record path",
    },
    {
      $type: "space.roomy.room.createRoom.v0",
      id: fx.channel,
      kind: "space.roomy.channel",
      name: "general",
    },
    {
      $type: "space.roomy.room.createRoom.v0",
      id: fx.thread,
      kind: "space.roomy.thread",
      name: "a thread",
    },
    {
      $type: "space.roomy.room.createRoom.v0",
      id: fx.spare,
      kind: "space.roomy.channel",
      name: "spare",
    },
    // Two kinds in one event: the room and the system message. `room` is not
    // converted, so the whole entry stays on the event path.
    {
      $type: "space.roomy.link.createRoomLink.v0",
      id: fx.linkMessage,
      room: fx.channel,
      linkToRoom: fx.thread,
      isCreationLink: true,
    },
    // Every attachment type, on a reply to the link message so the `reply`
    // edge's target exists.
    {
      $type: "space.roomy.message.createMessage.v0",
      id: fx.attached,
      room: fx.channel,
      body: markdown("attachments https://example.com/attached"),
      extensions: {
        "space.roomy.extension.attachments.v0": {
          attachments: [
            { $type: "space.roomy.attachment.reply.v0", target: fx.linkMessage },
            {
              $type: "space.roomy.attachment.comment.v0",
              version: fx.pageEdit,
              snippet: "a snippet",
              from: 0,
              to: 9,
            },
            {
              $type: "space.roomy.attachment.image.v0",
              uri: "https://cdn.example.com/a.png",
              mimeType: "image/png",
              alt: "an image",
              width: 10,
              height: 20,
              size: 30,
            },
            {
              $type: "space.roomy.attachment.video.v0",
              uri: "https://cdn.example.com/a.mp4",
              mimeType: "video/mp4",
              width: 10,
              height: 20,
              length: 5,
            },
            {
              $type: "space.roomy.attachment.file.v0",
              uri: "https://cdn.example.com/a.pdf",
              mimeType: "application/pdf",
              name: "a.pdf",
              size: 40,
            },
            {
              $type: "space.roomy.attachment.link.v0",
              uri: "https://example.com/embed",
              showPreview: true,
            },
            {
              $type: "space.roomy.attachment.forward.v0",
              target: fx.linkMessage,
              fromRoomId: fx.channel,
            },
          ],
        },
      },
    },
    {
      $type: "space.roomy.message.createMessage.v0",
      id: fx.plain,
      room: fx.channel,
      body: markdown("a link https://example.com/plain"),
      extensions: {},
    },
    {
      $type: "space.roomy.message.createMessage.v0",
      id: fx.rich,
      room: fx.channel,
      body: richtext("a facet", "https://example.com/facet"),
      extensions: {},
    },
    {
      $type: "space.roomy.message.createMessage.v0",
      id: fx.bridged,
      room: fx.thread,
      body: markdown("bridged"),
      extensions: {
        "space.roomy.extension.authorOverride.v0": { did: BRIDGED },
        "space.roomy.extension.timestampOverride.v0": {
          timestamp: RECEIVED_AT - 60_000,
        },
      },
    },
    // A legacy forward: a reference entity in the thread, and a forward edge.
    {
      $type: "space.roomy.message.forwardMessages.v0",
      id: newUlid(),
      room: fx.thread,
      messageIds: [fx.attached],
      fromRoomId: fx.channel,
    },
    // Content replacement, no attachment extension.
    {
      $type: "space.roomy.message.editMessage.v0",
      id: newUlid(),
      room: fx.channel,
      messageId: fx.plain,
      body: markdown("edited https://example.com/edited"),
    },
    // A link-only edit: an embed preview toggle, which must not wipe the
    // message's other attachments.
    {
      $type: "space.roomy.message.editMessage.v0",
      id: newUlid(),
      room: fx.channel,
      messageId: fx.attached,
      body: markdown("attachments https://example.com/attached"),
      extensions: {
        "space.roomy.extension.attachments.v0": {
          attachments: [
            {
              $type: "space.roomy.attachment.link.v0",
              uri: "https://example.com/embed",
              showPreview: false,
            },
          ],
        },
      },
    },
    // A full attachment replacement: the media rows go, the new set arrives.
    {
      $type: "space.roomy.message.editMessage.v0",
      id: newUlid(),
      room: fx.channel,
      messageId: fx.plain,
      body: markdown("edited with an image"),
      extensions: {
        "space.roomy.extension.attachments.v0": {
          attachments: [
            {
              $type: "space.roomy.attachment.image.v0",
              uri: "https://cdn.example.com/b.png",
              mimeType: "image/png",
            },
          ],
        },
      },
    },
    {
      $type: "space.roomy.message.moveMessages.v0",
      id: newUlid(),
      room: fx.thread,
      messageIds: [fx.bridged],
      toRoomId: fx.channel,
    },
    // Removes the message, and the forward reference pointing at it.
    {
      $type: "space.roomy.message.deleteMessage.v0",
      id: newUlid(),
      room: fx.channel,
      messageId: fx.attached,
    },
    // A create after the thread's window was rebuilt, so the feed upsert's
    // own effect is final for that room.
    {
      $type: "space.roomy.message.createMessage.v0",
      id: newUlid(),
      room: fx.thread,
      body: markdown("after the rebuild"),
      extensions: {},
    },
    // Last, into a room with no messages, so nothing else writes that room's
    // summary: a forward reference carries no content, and folding it into the
    // room's `room_activity` would be visible here and nowhere else.
    {
      $type: "space.roomy.message.forwardMessages.v0",
      id: newUlid(),
      room: fx.spare,
      messageIds: [fx.linkMessage],
      fromRoomId: fx.channel,
    },
  ] as unknown as Event[];

  return {
    entries: events.map((event, i) => logged(event, i + 1)),
    fx,
  };
}

/** The tables a masked comparison leaves out. */
function withoutLastEdit(tables: TableSnapshot[]): TableSnapshot[] {
  return tables.map((table) => {
    if (table.table !== "comp_content") return table;
    const keep = table.columns
      .map((column, i) => (column === "last_edit" ? -1 : i))
      .filter((i) => i >= 0);
    return {
      table: table.table,
      columns: table.columns.filter((column) => column !== "last_edit"),
      rows: table.rows.map((row) => keep.map((i) => row[i])),
    };
  });
}

interface Derived {
  space: TableSnapshot[];
  entitySpace: unknown[];
  pendingLinks: unknown[];
}

/**
 * Derive the corpus into a fresh space, through the record path or — with
 * `eventPath` — through the materialisers it replaces.
 *
 * `pageEdit` seeds the `comp_page_edits` row a comment attachment's `version`
 * references: pages have been retired from the write path, but the comment
 * attachment type still points at one, and both derivations must write the same
 * `comp_comment` row against it.
 */
async function derive(
  entries: LoggedEvent[],
  pageEdit: string,
  opts: { eventPath: boolean; isBackfill: boolean },
): Promise<Derived> {
  const db = freshSpaceDb();
  const globalDb = freshGlobalDb();
  await db.run("insert into entities (id, stream_id) values (?, ?)", [
    STREAM,
    STREAM,
  ]);
  await db.run("insert into comp_space (entity) values (?)", [STREAM]);
  await db.run(
    `insert into comp_page_edits (edit_id, entity, mime_type, data, user_id)
     values (?, ?, 'text/markdown', x'', ?)`,
    [pageEdit, STREAM, USER],
  );

  const apply = () =>
    applyBatch(
      db,
      STREAM,
      entries,
      { isBackfill: opts.isBackfill },
      toAsyncDb(globalDb),
    );
  const stats = await (opts.eventPath ? _withEventPath(apply) : apply());

  expect(stats.failed).toEqual([]);
  expect(stats.applyErrors).toBe(0);
  expect(stats.materializerErrors).toBe(0);

  return {
    space: await snapshotSpaceDb(db),
    entitySpace: globalDb
      .query("select entity_id, space_did from entity_space order by entity_id")
      .all(),
    pendingLinks: globalDb
      .query(
        "select space_did, message_id, url from pending_links order by url",
      )
      .all(),
  };
}

describe("the message record path derives what the event path derives", () => {
  test("a live write: every derived table matches", async () => {
    const { entries, fx } = corpus();
    const eventPath = await derive(entries, fx.pageEdit, {
      eventPath: true,
      isBackfill: false,
    });
    const recordPath = await derive(entries, fx.pageEdit, {
      eventPath: false,
      isBackfill: false,
    });

    // The derivation wrote rows, so this is not two empty databases agreeing.
    expect(eventPath.space.some((t) => t.rows.length > 0)).toBe(true);

    // The only table that differs, and only in `comp_content.last_edit`; see
    // the file header. Everything else is compared as it is.
    expect(diffSnapshots(eventPath.space, recordPath.space).map((d) => d.table)).toEqual([
      "comp_content",
    ]);
    expect(
      diffSnapshots(
        withoutLastEdit(eventPath.space),
        withoutLastEdit(recordPath.space),
      ),
    ).toEqual([]);
    expect(digestOf(withoutLastEdit(recordPath.space))).toBe(
      digestOf(withoutLastEdit(eventPath.space)),
    );
  });

  test("a replay: every derived table matches", async () => {
    const { entries, fx } = corpus();
    const eventPath = await derive(entries, fx.pageEdit, {
      eventPath: true,
      isBackfill: true,
    });
    const recordPath = await derive(entries, fx.pageEdit, {
      eventPath: false,
      isBackfill: true,
    });

    expect(diffSnapshots(eventPath.space, recordPath.space).map((d) => d.table)).toEqual([
      "comp_content",
    ]);
    expect(
      diffSnapshots(
        withoutLastEdit(eventPath.space),
        withoutLastEdit(recordPath.space),
      ),
    ).toEqual([]);
  });

  test("the global entity→space and pending-link indexes match", async () => {
    const { entries, fx } = corpus();
    const eventPath = await derive(entries, fx.pageEdit, {
      eventPath: true,
      isBackfill: false,
    });
    const recordPath = await derive(entries, fx.pageEdit, {
      eventPath: false,
      isBackfill: false,
    });

    expect(recordPath.entitySpace).toEqual(eventPath.entitySpace);
    expect(recordPath.pendingLinks).toEqual(eventPath.pendingLinks);
    // The corpus found links, so the comparison above is not two empty lists.
    expect(recordPath.pendingLinks.length).toBeGreaterThan(0);
  });
});

describe("`last_edit` is the one value the record model cannot reproduce", () => {
  test("it is the write's identity: an edit event's id, or the change's stamp", async () => {
    const { entries, fx } = corpus();
    const db = freshSpaceDb();
    await db.run("insert into entities (id, stream_id) values (?, ?)", [
      STREAM,
      STREAM,
    ]);
    await db.run("insert into comp_space (entity) values (?)", [STREAM]);
    await applyBatch(db, STREAM, entries, { isBackfill: false });

    // `plain` was edited twice, `attached` once, and the rest never.
    const rows = await db
      .query("select entity, last_edit from comp_content order by entity")
      .all<{ entity: string; last_edit: string }>();
    const lastEdit = new Map(rows.map((r) => [r.entity, r.last_edit]));

    // The read path's rule: a message is edited when `last_edit` is not its
    // own id. It is the only thing the column is asked, so a stamp that is not
    // an event ULID reads the same as one that is.
    expect(lastEdit.get(fx.plain)).not.toBe(fx.plain);
    expect(lastEdit.get(fx.attached)).not.toBe(fx.attached);
    expect(lastEdit.get(fx.rich)).toBe(fx.rich);
    expect(lastEdit.get(fx.bridged)).toBe(fx.bridged);
  });
});

describe("routing is decided by the kinds an event emits", () => {
  test("every entry whose kinds are converted routes, including the link", async () => {
    const { entries, fx } = corpus();
    const routed = entries.filter((entry) => convertedChanges(entry, STREAM));

    expect([...CONVERTED_KINDS].sort()).toEqual([
      "message",
      "reaction",
      "room",
      "spaceInfo",
      "spaceSidebar",
    ]);
    expect(
      [...new Set(routed.map((entry) => entry.event.$type))].sort(),
    ).toEqual([
      "space.roomy.link.createRoomLink.v0",
      "space.roomy.message.createMessage.v0",
      "space.roomy.message.deleteMessage.v0",
      "space.roomy.message.editMessage.v0",
      "space.roomy.message.forwardMessages.v0",
      "space.roomy.message.moveMessages.v0",
      "space.roomy.room.createRoom.v0",
      "space.roomy.space.updateSpaceInfo.v0",
    ]);

    // `createRoomLink` emits a `room` and a `message`; both kinds are
    // converted, so the entry routes and the message is applied exactly once.
    const link = entries.find((entry) => entry.event.id === fx.linkMessage)!;
    expect(convertedChanges(link, STREAM)).not.toBeNull();

    const db = freshSpaceDb();
    await db.run("insert into entities (id, stream_id) values (?, ?)", [
      STREAM,
      STREAM,
    ]);
    await db.run("insert into comp_space (entity) values (?)", [STREAM]);
    await applyBatch(db, STREAM, entries, { isBackfill: false });
    const rows = await db
      .query("select count(*) as n from entities where id = ?")
      .get<{ n: number }>(fx.linkMessage);
    expect(rows?.n).toBe(1);
  });
});

describe("an entry the adapter cannot describe", () => {
  test("still applies, because it goes back to the event path", async () => {
    const channel = newUlid();
    const message = newUlid();
    // An edit whose own id is not a ULID and which carries no receipt instant
    // to order it by: the adapter cannot stamp it. Routing it back to the event
    // path is what keeps one unreadable row from failing the batch — the
    // event materialiser never reads the edit's id for ordering.
    const unstampable = {
      $type: "space.roomy.message.editMessage.v0",
      id: "not-a-ulid",
      room: channel,
      messageId: message,
      body: markdown("edited"),
    } as unknown as Event;
    const unstampableEntry: LoggedEvent = {
      event: unstampable,
      idx: 3 as StreamIndex,
      user: USER,
    };

    expect(convertedChanges(unstampableEntry, STREAM)).toBeNull();

    const entries: LoggedEvent[] = [
      logged(
        {
          $type: "space.roomy.room.createRoom.v0",
          id: channel,
          kind: "space.roomy.channel",
          name: "general",
        } as unknown as Event,
        1,
      ),
      logged(
        {
          $type: "space.roomy.message.createMessage.v0",
          id: message,
          room: channel,
          body: markdown("original"),
          extensions: {},
        } as unknown as Event,
        2,
      ),
      unstampableEntry,
      logged(
        {
          $type: "space.roomy.message.createMessage.v0",
          id: newUlid(),
          room: channel,
          body: markdown("after"),
          extensions: {},
        } as unknown as Event,
        4,
      ),
    ];

    const db = freshSpaceDb();
    await db.run("insert into entities (id, stream_id) values (?, ?)", [
      STREAM,
      STREAM,
    ]);
    await db.run("insert into comp_space (entity) values (?)", [STREAM]);
    const stats = await applyBatch(db, STREAM, entries, { isBackfill: false });

    expect(stats.failed).toEqual([]);
    expect(stats.applied).toBe(4);

    // The edit landed, and the message after it did too.
    const content = await db
      .query("select data from comp_content where entity = ?")
      .get<{ data: Uint8Array }>(message);
    expect(new TextDecoder().decode(content!.data)).toBe("edited");
  });
});
