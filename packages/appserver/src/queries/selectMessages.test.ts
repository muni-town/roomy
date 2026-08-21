import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { StreamDid, UserDid, newUlid } from "@roomy-space/sdk";
import type { DbLike } from "../db/types.ts";
import { toAsyncDb } from "../db/syncAdapter.ts";
import { closeDb, openDb, openGlobalDb } from "../db/db.ts";
import { selectMessages } from "./selectMessages.ts";
import { _resetProfileStoreCache } from "./profileStore.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMA_PATH = join(__dirname, "..", "db", "schema-space.sql");

const STREAM = StreamDid.assert("did:web:test-stream.example");
const USER = UserDid.assert("did:plc:test-user");

beforeEach(() => {
  closeDb();
  openDb({ path: ":memory:" });
  _resetProfileStoreCache();
});
afterEach(() => closeDb());

/** Raw in-memory per-space DB seeded with schema-space.sql. */
function freshSpaceDb(): DbLike {
  const db = new Database(":memory:");
  db.exec("pragma journal_mode = wal");
  db.exec("pragma synchronous = normal");
  db.exec("pragma foreign_keys = on");
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  return toAsyncDb(db);
}

/** Seed the global profile store (via the worker global DB). */
async function seedGlobalProfile(
  did: string,
  handle: string | null,
  name: string | null,
): Promise<void> {
  const g = await openGlobalDb();
  await g.run(
    "insert into profiles (did, handle, name, updated_at) values (?, ?, ?, ?)",
    [did, handle, name, Date.now()],
  );
}

describe("selectMessages system messages", () => {
  test("flags system messages and resolves the referenced user's DID label to a display name", async () => {
    const db = freshSpaceDb();
    const roomId = newUlid();
    const msgId = newUlid();

    // A system message authored by the space itself (author edge tail =
    // STREAM) referencing the joining user by DID in the deterministic label.
    await db.run("insert into entities (id, stream_id) values (?, ?)", [STREAM, STREAM]);
    await db.run(
      "insert into entities (id, stream_id, room) values (?, ?, ?)",
      [msgId, STREAM, roomId],
    );
    await db.run("insert into edges (head, tail, label) values (?, ?, 'author')", [
      msgId,
      STREAM,
    ]);
    const body = `[@${USER}](/user/${USER}) joined the space.`;
    await db.run(
      "insert into comp_content (entity, mime_type, data, last_edit) values (?, 'text/markdown', ?, ?)",
      [msgId, Buffer.from(body), msgId],
    );

    // Both the space (author) and the joining user are in the global store, so
    // no on-demand network hydration is triggered.
    await seedGlobalProfile(STREAM, null, "Test Space");
    await seedGlobalProfile(USER, "alice.bsky.social", "Alice Example");

    const { messages } = await selectMessages(db, {
      kind: "room",
      roomId,
      limit: 50,
      cursor: null,
    });

    expect(messages.length).toBe(1);
    const m = messages[0]!;
    expect(m.system).toBe(true);
    // The DID label must be replaced by the display name (no leading @ — the
    // @ marker is only for handle labels); the raw DID never shows in the
    // message body.
    expect(m.content).toBe(`[Alice Example](/user/${USER}) joined the space.`);
    // The raw DID must never appear as the visible link label.
    expect(m.content).not.toContain(`[@${USER}]`);
  });

  test("users with only a handle keep the leading @ in the label", async () => {
    const db = freshSpaceDb();
    const roomId = newUlid();
    const msgId = newUlid();

    await db.run("insert into entities (id, stream_id) values (?, ?)", [STREAM, STREAM]);
    await db.run(
      "insert into entities (id, stream_id, room) values (?, ?, ?)",
      [msgId, STREAM, roomId],
    );
    await db.run("insert into edges (head, tail, label) values (?, ?, 'author')", [
      msgId,
      STREAM,
    ]);
    const body = `[@${USER}](/user/${USER}) joined the space.`;
    await db.run(
      "insert into comp_content (entity, mime_type, data, last_edit) values (?, 'text/markdown', ?, ?)",
      [msgId, Buffer.from(body), msgId],
    );

    await seedGlobalProfile(STREAM, null, "Test Space");
    // No display name — only a handle.
    await seedGlobalProfile(USER, "alice.bsky.social", null);

    const { messages } = await selectMessages(db, {
      kind: "room",
      roomId,
      limit: 50,
      cursor: null,
    });

    expect(messages.length).toBe(1);
    const m = messages[0]!;
    expect(m.system).toBe(true);
    // Handle labels keep the @ marker; display names drop it.
    expect(m.content).toBe(`[@alice.bsky.social](/user/${USER}) joined the space.`);
  });

  test("user-authored messages are not flagged system and are not rewritten", async () => {
    const db = freshSpaceDb();
    const roomId = newUlid();
    const msgId = newUlid();

    await db.run("insert into entities (id, stream_id) values (?, ?)", [STREAM, STREAM]);
    await db.run("insert into entities (id, stream_id) values (?, ?)", [USER, STREAM]);
    await db.run(
      "insert into entities (id, stream_id, room) values (?, ?, ?)",
      [msgId, STREAM, roomId],
    );
    await db.run("insert into edges (head, tail, label) values (?, ?, 'author')", [
      msgId,
      USER,
    ]);
    const body = `[@Alice Example](/user/${USER}) hello`;
    await db.run(
      "insert into comp_content (entity, mime_type, data, last_edit) values (?, 'text/markdown', ?, ?)",
      [msgId, Buffer.from(body), msgId],
    );

    await seedGlobalProfile(USER, "alice.bsky.social", "Alice Example");

    const { messages } = await selectMessages(db, {
      kind: "room",
      roomId,
      limit: 50,
      cursor: null,
    });

    expect(messages.length).toBe(1);
    const m = messages[0]!;
    expect(m.system).toBeUndefined();
    // Not a system message: content left untouched.
    expect(m.content).toBe(body);
  });
});
