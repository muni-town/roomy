import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb } from "../db/db.ts";
import {
  resolveAvatarUrl,
  resolveEntityAvatar,
  resolveMessageIcon,
  resolveLatestRoomAuthor,
} from "./avatars.ts";

/**
 * Unit tests for the push avatar resolver. The appserver must turn
 * `atblob://<did>/<cid>` refs into public CDN URLs (the OS fetches the
 * notification icon itself) — mirroring `app-lite`'s `resolveBlobUrl` exactly
 * so push icons match in-app avatars.
 */

describe("push/avatars — resolveAvatarUrl", () => {
  test("resolves an atblob:// ref to the Bluesky CDN fullsize URL", () => {
    expect(resolveAvatarUrl("atblob://did:plc:abc/cid123")).toBe(
      "https://cdn.bsky.app/img/feed_fullsize/plain/did:plc:abc/cid123",
    );
  });

  test("passes a plain https URL through unchanged", () => {
    const url = "https://example.com/avatar.png";
    expect(resolveAvatarUrl(url)).toBe(url);
  });

  test("returns undefined for null / empty / missing", () => {
    expect(resolveAvatarUrl(null)).toBeUndefined();
    expect(resolveAvatarUrl(undefined)).toBeUndefined();
    expect(resolveAvatarUrl("")).toBeUndefined();
  });

  test("returns undefined for a malformed atblob ref (no cid)", () => {
    expect(resolveAvatarUrl("atblob://did:plc:abc")).toBeUndefined();
  });
});

describe("push/avatars — DB-backed resolution", () => {
  function dbWithInfo(rows: [entity: string, avatar: string | null][]): Database {
    const db = openDb({ path: ":memory:", isolated: true });
    for (const [entity, avatar] of rows) {
      // comp_info.entity FKs -> entities.id, so seed the entity first.
      db.run("insert or ignore into entities (id, stream_id) values (?, ?)", [
        entity,
        entity,
      ]);
      db.run(
        "insert into comp_info (entity, name, avatar) values (?, ?, ?)",
        [entity, "n", avatar],
      );
    }
    return db;
  }

  test("resolveEntityAvatar resolves an atblob ref stored in comp_info", () => {
    const db = dbWithInfo([
      ["did:plc:alice", "atblob://did:plc:alice/cidA"],
    ]);
    expect(resolveEntityAvatar(db, "did:plc:alice")).toBe(
      "https://cdn.bsky.app/img/feed_fullsize/plain/did:plc:alice/cidA",
    );
  });

  test("resolveEntityAvatar returns undefined when no avatar / no row", () => {
    const db = dbWithInfo([
      ["did:plc:alice", null],
      ["did:plc:bob", "atblob://did:plc:bob/cidB"],
    ]);
    expect(resolveEntityAvatar(db, "did:plc:alice")).toBeUndefined();
    expect(resolveEntityAvatar(db, "did:plc:nobody")).toBeUndefined();
  });

  test("resolveMessageIcon prefers the sender avatar, falling back to space", () => {
    const db = dbWithInfo([
      ["did:plc:alice", "atblob://did:plc:alice/cidA"],
      ["did:web:space.example", "atblob://did:web:space/cidS"],
    ]);
    expect(resolveMessageIcon(db, "did:plc:alice", "did:web:space.example")).toBe(
      "https://cdn.bsky.app/img/feed_fullsize/plain/did:plc:alice/cidA",
    );
  });

  test("resolveMessageIcon falls back to the space avatar when sender has none", () => {
    const db = dbWithInfo([
      ["did:plc:alice", null],
      ["did:web:space.example", "atblob://did:web:space/cidS"],
    ]);
    expect(resolveMessageIcon(db, "did:plc:alice", "did:web:space.example")).toBe(
      "https://cdn.bsky.app/img/feed_fullsize/plain/did:web:space/cidS",
    );
  });

  test("resolveMessageIcon returns undefined when neither sender nor space has an avatar", () => {
    const db = dbWithInfo([
      ["did:plc:alice", null],
      ["did:web:space.example", null],
    ]);
    expect(
      resolveMessageIcon(db, "did:plc:alice", "did:web:space.example"),
    ).toBeUndefined();
  });
});

describe("push/avatars — resolveLatestRoomAuthor", () => {
  function dbWithRoom(
    roomId: string,
    messages: { id: string; sortIdx: number | null; author: string }[],
  ): Database {
    const db = openDb({ path: ":memory:", isolated: true });
    db.run("insert into entities (id, stream_id, room) values (?, ?, ?)", [
      roomId,
      "did:web:space.example",
      roomId,
    ]);
    // Ensure every distinct author has an entity row (edges.tail FKs -> entities.id).
    for (const author of [...new Set(messages.map((m) => m.author))]) {
      db.run("insert or ignore into entities (id, stream_id) values (?, ?)", [
        author,
        author,
      ]);
    }
    for (const m of messages) {
      // message entity in the room + its content + author edge
      db.run("insert into entities (id, stream_id, room) values (?, ?, ?)", [
        m.id,
        "did:web:space.example",
        roomId,
      ]);
      db.run(
        "insert into comp_content (entity, mime_type, data, last_edit, timestamp) values (?, 'text/plain', ?, ?, 0)",
        [m.id, Buffer.from("x"), m.id],
      );
      db.run(
        "insert into edges (head, tail, label) values (?, ?, 'author')",
        [m.id, m.author],
      );
      if (m.sortIdx != null) {
        db.run("update entities set sort_idx = ? where id = ?", [m.sortIdx, m.id]);
      }
    }
    return db;
  }

  test("returns the author of the most-recent message (by sort_idx)", () => {
    const db = dbWithRoom("01ROOM", [
      { id: "m1", sortIdx: 10, author: "did:plc:alice" },
      { id: "m2", sortIdx: 90, author: "did:plc:bob" },
      { id: "m3", sortIdx: 50, author: "did:plc:carol" },
    ]);
    expect(resolveLatestRoomAuthor(db, "01ROOM")).toBe("did:plc:bob");
  });

  test("falls back to id ordering when sort_idx is null", () => {
    const db = dbWithRoom("01ROOM", [
      { id: "01AAA", sortIdx: null, author: "did:plc:alice" },
      { id: "01ZZZ", sortIdx: null, author: "did:plc:bob" },
    ]);
    expect(resolveLatestRoomAuthor(db, "01ROOM")).toBe("did:plc:bob");
  });

  test("returns null for a room with no messages", () => {
    const db = openDb({ path: ":memory:", isolated: true });
    db.run("insert into entities (id, stream_id, room) values (?, ?, ?)", [
      "01ROOM",
      "did:web:space.example",
      "01ROOM",
    ]);
    expect(resolveLatestRoomAuthor(db, "01ROOM")).toBeNull();
  });
});