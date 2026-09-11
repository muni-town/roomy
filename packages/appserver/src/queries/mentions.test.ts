import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { toAsyncDb } from "../db/syncAdapter.ts";
import type { DbLike } from "../db/types.ts";
import type { Ulid, UserDid, StreamDid } from "@roomy-space/sdk";
import type { AppliedEvent } from "../invalidation/types.ts";
import {
  syncMentionsIndex,
  getMentionedDidsForMessage,
  getMentions,
  resolveReplyToAuthors,
} from "./mentions.ts";

const STREAM = "did:web:space.example" as StreamDid;
const ROOM = "01KR32FDQCCCEB8FEK76SQST9Y" as Ulid;
const MSG = "01KR32FDQCCCEB8FEK76SQST9Z" as Ulid;
const MSG2 = "01KR32FDQCCCEB8FEK76SQSTA0" as Ulid;
const ALICE = "did:plc:alice" as UserDid;
const BOB = "did:plc:bob" as UserDid;

function makeGlobalDb(): DbLike {
  const db = new Database(":memory:");
  db.exec(
    "create table if not exists mentions (did text not null, message_id text not null, space_did text not null, room_id text not null, kind text not null default 'mention' check(kind in ('mention','reply')), created_at integer not null default (unixepoch() * 1000), primary key (did, message_id)) strict",
  );
  return toAsyncDb(db);
}

/** A per-space DB with just the `edges` table the reply resolution queries. */
function makeSpaceDb(): DbLike {
  const db = new Database(":memory:");
  db.exec(
    "create table if not exists edges (head text not null, tail text not null, label text not null, primary key (head, tail, label)) strict",
  );
  return toAsyncDb(db);
}

async function seedReplyEdge(
  db: DbLike,
  head: string,
  target: string,
  targetAuthor: string,
): Promise<void> {
  // head → target (the reply edge from the new message)
  await db.run("insert into edges (head, tail, label) values (?, ?, 'reply')", [head, target]);
  // target → author
  await db.run("insert into edges (head, tail, label) values (?, ?, 'author')", [
    target,
    targetAuthor,
  ]);
}

function createEvent(overrides: Partial<AppliedEvent> = {}): AppliedEvent {
  return {
    type: "space.roomy.message.createMessage.v0",
    streamDid: STREAM,
    user: ALICE,
    id: MSG,
    roomId: ROOM,
    details: { mentions: [BOB] },
    ...overrides,
  } as AppliedEvent;
}

describe("mentions index", () => {
  test("syncMentionsIndex inserts a row per mentioned DID (self-mentions included)", async () => {
    const db = makeGlobalDb();
    await syncMentionsIndex(db, [createEvent({ details: { mentions: [BOB, ALICE] } })]);
    const dids = await getMentionedDidsForMessage(db, MSG);
    expect(dids.sort()).toEqual([BOB, ALICE].sort());
  });

  test("syncMentionsIndex keeps self-mentions", async () => {
    const db = makeGlobalDb();
    // Author mentions themselves — the row is kept: self-mentions flow
    // through the normal mentions index (clients filter if they want).
    await syncMentionsIndex(db, [createEvent({ details: { mentions: [ALICE] } })]);
    const dids = await getMentionedDidsForMessage(db, MSG);
    expect(dids).toEqual([ALICE]);
    const { mentions } = await getMentions(db, ALICE, 10);
    expect(mentions).toHaveLength(1);
    expect(mentions[0]!.kind).toBe("mention");
  });

  test("syncMentionsIndex replaces rows on edit", async () => {
    const db = makeGlobalDb();
    await syncMentionsIndex(db, [createEvent()]);
    const carol = "did:plc:carol" as UserDid;
    await syncMentionsIndex(db, [
      createEvent({
        type: "space.roomy.message.editMessage.v0",
        details: { messageId: MSG, mentions: [carol] },
      }),
    ]);
    const dids = await getMentionedDidsForMessage(db, MSG);
    expect(dids).toEqual([carol]);
  });

  test("syncMentionsIndex removes rows on delete", async () => {
    const db = makeGlobalDb();
    await syncMentionsIndex(db, [createEvent()]);
    await syncMentionsIndex(db, [
      createEvent({
        type: "space.roomy.message.deleteMessage.v0",
        details: { messageId: MSG },
      }),
    ]);
    const dids = await getMentionedDidsForMessage(db, MSG);
    expect(dids).toEqual([]);
  });

  test("getMentions returns newest-first with cursor pagination", async () => {
    const db = makeGlobalDb();
    // Insert two mentions for BOB with different timestamps.
    const m1 = "01KR32FDQCCCEB8FEK76SQST9A" as Ulid;
    const m2 = "01KR32FDQCCCEB8FEK76SQST9B" as Ulid;
    await db.run(
      "insert into mentions (did, message_id, space_did, room_id, created_at) values (?, ?, ?, ?, ?)",
      [BOB, m1, STREAM, ROOM, 1000],
    );
    await db.run(
      "insert into mentions (did, message_id, space_did, room_id, created_at) values (?, ?, ?, ?, ?)",
      [BOB, m2, STREAM, ROOM, 2000],
    );

    const { mentions, cursor } = await getMentions(db, BOB, 1);
    expect(mentions).toHaveLength(1);
    expect(mentions[0]!.message_id).toBe(m2); // newest first
    expect(cursor).toBeDefined();

    const page2 = await getMentions(db, BOB, 1, cursor);
    expect(page2.mentions).toHaveLength(1);
    expect(page2.mentions[0]!.message_id).toBe(m1);
    expect(page2.mentions[0]!.kind).toBe("mention");
    expect(page2.cursor).toBeUndefined();
  });

  test("createMessage writes a kind='reply' row for the replied-to author only (depth-1)", async () => {
    const globalDb = makeGlobalDb();
    const spaceDb = makeSpaceDb();
    // ALICE replies to MSG2 (authored by BOB).
    await seedReplyEdge(spaceDb, MSG, MSG2, BOB);
    await syncMentionsIndex(globalDb, [createEvent({ details: { mentions: [] } })], {
      spaceDb,
    });
    const dids = await getMentionedDidsForMessage(globalDb, MSG);
    expect(dids).toEqual([BOB]);
    const { mentions } = await getMentions(globalDb, BOB, 10);
    expect(mentions).toHaveLength(1);
    expect(mentions[0]!.kind).toBe("reply");
  });

  test("self-reply (replied-to author is the reply's author) writes no reply row", async () => {
    const globalDb = makeGlobalDb();
    const spaceDb = makeSpaceDb();
    // ALICE replies to her own message (author = ALICE = event.user).
    await seedReplyEdge(spaceDb, MSG, MSG2, ALICE);
    await syncMentionsIndex(globalDb, [createEvent({ details: { mentions: [] } })], {
      spaceDb,
    });
    const dids = await getMentionedDidsForMessage(globalDb, MSG);
    expect(dids).toEqual([]);
  });

  test("reply-over-mention overlap yields a single kind='reply' row", async () => {
    const globalDb = makeGlobalDb();
    const spaceDb = makeSpaceDb();
    // ALICE both mentions BOB and replies to BOB's message.
    await seedReplyEdge(spaceDb, MSG, MSG2, BOB);
    await syncMentionsIndex(globalDb, [createEvent({ details: { mentions: [BOB] } })], {
      spaceDb,
    });
    const dids = await getMentionedDidsForMessage(globalDb, MSG);
    expect(dids).toEqual([BOB]);
    const { mentions } = await getMentions(globalDb, BOB, 10);
    expect(mentions).toHaveLength(1);
    expect(mentions[0]!.kind).toBe("reply");
  });

  test("resolveReplyToAuthors is batched per head id", async () => {
    const spaceDb = makeSpaceDb();
    await seedReplyEdge(spaceDb, MSG, MSG2, BOB);
    const map = await resolveReplyToAuthors(spaceDb, [MSG, MSG2]);
    expect(map.get(MSG)).toBe(BOB);
    expect(map.has(MSG2)).toBe(false); // MSG2 has no reply edge
  });

  test("editMessage writes reply rows keyed by messageId (not the edit event id)", async () => {
    const globalDb = makeGlobalDb();
    const spaceDb = makeSpaceDb();
    const EDIT_ID = "01KR32FDQCCCEB8FEK76SQSTA1" as Ulid;
    await seedReplyEdge(spaceDb, MSG, MSG2, BOB);
    // Edit event's own id differs from the message id — rows must key on the
    // latter (the original bug keyed on event.id, orphaning rows).
    await syncMentionsIndex(
      globalDb,
      [
        createEvent({
          type: "space.roomy.message.editMessage.v0",
          id: EDIT_ID,
          details: { messageId: MSG, mentions: [] },
        }),
      ],
      { spaceDb },
    );
    const dids = await getMentionedDidsForMessage(globalDb, MSG);
    expect(dids).toEqual([BOB]);
    const stray = await getMentionedDidsForMessage(globalDb, EDIT_ID);
    expect(stray).toEqual([]);
  });
});
