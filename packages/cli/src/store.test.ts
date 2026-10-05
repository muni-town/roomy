import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cache } from "@roomy-space/sdk";
import {
  CACHE_BUILD_ID,
  FileStore,
  roomFileName,
  rowsToEntries,
  spaceDir,
} from "./store.js";
import type { MessageInfo } from "./messages.js";

const tmpdirPath = () => mkdtemp(join(tmpdir(), "roomy-store-"));

const row = (
  messageId: string,
  timestamp = "2026-01-01T00:00:00.000Z",
): MessageInfo => ({
  id: messageId,
  authorDid: "did:plc:author",
  authorName: "Author",
  content: `message ${messageId}`,
  timestamp,
});

const ACCOUNT = "did:plc:alice";
const ROOM = "01M0ROOM00000000000000000";
const OTHER = "01M0ROOM00000000000000001";

const readSnapshotFile = async (file: string) =>
  JSON.parse(await readFile(file, "utf8")) as {
    version: string;
    account: string;
    entries: Array<{ state: Record<string, unknown> }>;
  };

describe("FileStore", () => {
  test("round-trips a room's rows in timeline order", async () => {
    const dir = await tmpdirPath();
    const store = new FileStore({ dir, account: ACCOUNT });
    const rows = [row("01M0001"), row("01M0002"), row("01M0003")];

    await store.saveRoom(ROOM, rows, true);
    const loaded = await store.loadRoom(ROOM);

    expect(loaded.rows.map((m) => m.id)).toEqual([
      "01M0001",
      "01M0002",
      "01M0003",
    ]);
    expect(loaded.complete).toBe(true);
    // One file per room, and no temp file left behind by the atomic write.
    expect(await readdir(dir)).toEqual([roomFileName(ROOM)]);
  });

  test("a second write replaces the room's rows rather than appending", async () => {
    const dir = await tmpdirPath();
    const store = new FileStore({ dir, account: ACCOUNT });

    await store.saveRoom(ROOM, [row("01M0001"), row("01M0002")], true);
    await store.saveRoom(ROOM, [row("01M0002"), row("01M0003")], true);

    expect((await store.loadRoom(ROOM)).rows.map((m) => m.id)).toEqual([
      "01M0002",
      "01M0003",
    ]);
  });

  test("rooms are independent files", async () => {
    const dir = await tmpdirPath();
    const store = new FileStore({ dir, account: ACCOUNT });

    await store.saveRoom(ROOM, [row("01M0001")], true);
    await store.saveRoom(OTHER, [row("01M0002")], true);

    expect((await store.loadRoom(ROOM)).rows.map((m) => m.id)).toEqual([
      "01M0001",
    ]);
    expect((await store.loadRoom(OTHER)).rows.map((m) => m.id)).toEqual([
      "01M0002",
    ]);
  });

  test("an incomplete room keeps its flag across a load", async () => {
    const dir = await tmpdirPath();
    const store = new FileStore({ dir, account: ACCOUNT });

    await store.saveRoom(ROOM, [row("01M0002")], false);
    expect((await store.loadRoom(ROOM)).complete).toBe(false);
  });

  test("a torn room file degrades to 'not cached', never to a partial read", async () => {
    const dir = await tmpdirPath();
    const store = new FileStore({ dir, account: ACCOUNT });
    await store.saveRoom(ROOM, [row("01M0001"), row("01M0002")], true);

    // Simulate a kill between write and rename: the file is half a snapshot. A
    // reader must not see the first row and call it the room's history.
    const file = join(dir, roomFileName(ROOM));
    const whole = await readFile(file, "utf8");
    await writeFile(file, whole.slice(0, 60));

    expect(await store.loadRoom(ROOM)).toEqual({ rows: [], complete: false });
  });

  test("a snapshot of another shape version is discarded whole", async () => {
    const dir = await tmpdirPath();
    const store = new FileStore({ dir, account: ACCOUNT });
    await store.saveRoom(ROOM, [row("01M0001")], true);

    const file = join(dir, roomFileName(ROOM));
    const snapshot = await readSnapshotFile(file);
    snapshot.version = "0:an-old-build";
    await writeFile(file, JSON.stringify(snapshot));

    expect((await store.loadRoom(ROOM)).rows).toEqual([]);
  });

  test("a snapshot written for another account is discarded", async () => {
    const dir = await tmpdirPath();
    const theirs = new FileStore({ dir, account: "did:plc:someone-else" });
    await theirs.saveRoom(ROOM, [row("01M0001")], true);

    const mine = new FileStore({ dir, account: ACCOUNT });
    expect((await mine.loadRoom(ROOM)).rows).toEqual([]);
  });

  test("a missing directory is an empty cache, not an error", async () => {
    const dir = join(await tmpdirPath(), "does-not-exist");
    const store = new FileStore({ dir, account: ACCOUNT });
    expect(await store.loadRoom(ROOM)).toEqual({ rows: [], complete: false });
    expect(await store.load()).toEqual([]);
  });

  test("a state whose id disagrees with its key is dropped", async () => {
    const dir = await tmpdirPath();
    const store = new FileStore({ dir, account: ACCOUNT });
    await store.saveRoom(ROOM, [row("01M0001"), row("01M0002")], true);

    const file = join(dir, roomFileName(ROOM));
    const snapshot = await readSnapshotFile(file);
    snapshot.entries[0]!.state.id = "01M9999";
    await writeFile(file, JSON.stringify(snapshot));

    expect((await store.loadRoom(ROOM)).rows.map((m) => m.id)).toEqual([
      "01M0002",
    ]);
  });

  test("the per-room budget keeps the newest rows and clears completeness", async () => {
    const dir = await tmpdirPath();
    const store = new FileStore({ dir, account: ACCOUNT, maxRowsPerRoom: 2 });
    const rows = [
      row("01M0001", "2026-01-01T00:00:00.000Z"),
      row("01M0002", "2026-01-01T00:00:01.000Z"),
      row("01M0003", "2026-01-01T00:00:02.000Z"),
    ];

    await store.saveRoom(ROOM, rows, true);
    const loaded = await store.loadRoom(ROOM);

    expect(loaded.rows.map((m) => m.id)).toEqual(["01M0002", "01M0003"]);
    // Rows were dropped, so the file no longer reaches the room's oldest
    // message and must not claim that it does.
    expect(loaded.complete).toBe(false);
  });

  test("the seam's save/load name every room and drop files no entry names", async () => {
    const dir = await tmpdirPath();
    const store = new FileStore({ dir, account: ACCOUNT });

    await store.save([
      ...rowsToEntries(ROOM, [row("01M0001")]),
      ...rowsToEntries(OTHER, [row("01M0002")]),
    ]);
    expect((await readdir(dir)).sort()).toEqual(
      [roomFileName(ROOM), roomFileName(OTHER)].sort(),
    );
    // The seam's set is a cache's contents, not a room history, so a room it
    // writes is never marked complete.
    expect((await store.loadRoom(ROOM)).complete).toBe(false);

    await store.save(rowsToEntries(ROOM, [row("01M0001")]));
    expect(await readdir(dir)).toEqual([roomFileName(ROOM)]);
  });

  test("the seam's save/load name every room and drop files no entry names", async () => {
    const dir = await tmpdirPath();
    const store = new FileStore({ dir, account: ACCOUNT });

    await store.save([
      ...rowsToEntries(ROOM, [row("01M0001")]),
      ...rowsToEntries(OTHER, [row("01M0002")]),
    ]);
    expect((await readdir(dir)).sort()).toEqual(
      [roomFileName(ROOM), roomFileName(OTHER)].sort(),
    );

    await store.save(rowsToEntries(ROOM, [row("01M0001")]));
    expect(await readdir(dir)).toEqual([roomFileName(ROOM)]);
  });

  test("save writes under the current persisted-shape version and the account", async () => {
    const dir = await tmpdirPath();
    const store = new FileStore({ dir, account: ACCOUNT });
    await store.saveRoom(ROOM, [row("01M0001")], true);

    const snapshot = await readSnapshotFile(join(dir, roomFileName(ROOM)));
    expect(snapshot.version).toBe(cache.persistedShapeVersion(CACHE_BUILD_ID));
    expect(snapshot.account).toBe(ACCOUNT);
  });
});

describe("spaceDir and roomFileName", () => {
  test("encode ids so a hostile id stays one path segment", () => {
    const dir = spaceDir("/tmp/cache", "../../etc");
    expect(dir.startsWith("/tmp/cache/")).toBe(true);
    expect(dir.slice("/tmp/cache/".length)).not.toContain("/");
    expect(roomFileName("../../etc/passwd")).toBe(
      `${encodeURIComponent("../../etc/passwd")}.json`,
    );
    expect(roomFileName("../../etc/passwd")).not.toContain("/");
  });

  test("distinct spaces do not share a directory", () => {
    expect(spaceDir("/tmp/cache", "did:plc:a")).not.toBe(
      spaceDir("/tmp/cache", "did:plc:b"),
    );
  });
});
