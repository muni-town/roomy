import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  CSV_COLUMNS,
  collectExport,
  defaultOutPath,
  encodeCsv,
  encodeJson,
  type ExportOptions,
  type ExportRow,
} from "./export.js";
import { MAX_PAGE_LIMIT } from "./messages.js";

const id = (n: number) => `01M0${String(n).padStart(20, "0")}`;

const row = (over: Partial<ExportRow> = {}): ExportRow => ({
  id: "01M0001",
  timestamp: "2026-01-01T00:00:00.000Z",
  authorDid: "did:plc:author",
  authorName: "Author",
  roomId: "room:1",
  roomName: "general",
  replyTo: null,
  text: "hello",
  ...over,
});

const cacheDirOf = () => mkdtemp(join(tmpdir(), "roomy-export-"));

// ── CSV and JSON encoding ──────────────────────────────────────────────────

describe("CSV encoding", () => {
  test("writes the stable header even when there are no rows", () => {
    expect(encodeCsv([])).toBe(`${CSV_COLUMNS.join(",")}\r\n`);
  });

  test("a plain row needs no quoting", () => {
    const csv = encodeCsv([row()]);
    const [header, line] = csv.split("\r\n");
    expect(header).toBe(CSV_COLUMNS.join(","));
    expect(line).toBe(
      "01M0001,2026-01-01T00:00:00.000Z,did:plc:author,Author,room:1,general,,hello",
    );
  });

  test("quotes only the fields that need it", () => {
    const csv = encodeCsv([row({ roomName: "needs, comma" })]);
    expect(csv).toContain('room:1,"needs, comma",,hello');
  });

  test("commas, quotes and newlines survive RFC4180 quoting", () => {
    const text = 'a,b "quoted" line\nsecond, "line"';
    const csv = encodeCsv([row({ text })]);
    expect(parseCsv(csv)[1]!.at(-1)).toBe(text);
  });

  test("unicode text is written verbatim, not escaped", () => {
    const text = "héllo 🦊 世界";
    const csv = encodeCsv([row({ text })]);
    expect(csv).toContain(text);
    expect(parseCsv(csv)[1]!.at(-1)).toBe(text);
  });

  test("a reply id is a column, and its absence is an empty field", () => {
    const csv = encodeCsv([row({ replyTo: "01M0000" })]);
    expect(parseCsv(csv)[1]![6]).toBe("01M0000");
  });
});

describe("JSON encoding", () => {
  test("is an array of the same objects the CSV columns describe", () => {
    const rows = [row(), row({ id: "01M0002", text: "second" })];
    const parsed = JSON.parse(encodeJson(rows)) as ExportRow[];
    expect(parsed).toEqual(rows);
    expect(Object.keys(parsed[0]!).sort()).toEqual([...CSV_COLUMNS].sort());
  });
});

describe("defaultOutPath", () => {
  test("names the file after the space and the run", () => {
    const out = defaultOutPath(
      "did:plc:space",
      "csv",
      new Date("2026-01-02T03:04:05Z"),
    );
    expect(basename(out)).toBe(
      "roomy-export-did%3Aplc%3Aspace-2026-01-02T03-04-05-000Z.csv",
    );
  });
});

// ── a fake space, for the incremental path ─────────────────────────────────

interface FakeRoom {
  id: string;
  name: string;
  messages: string[];
}

/**
 * A fake appserver reproducing the parts `export` uses: the board
 * (`space.roomy.space.getThreads`) listing channels and threads with each
 * room's newest message, and `room.getMessages` with the real cursor semantics
 * (newest-first selection, ascending page, cursor = oldest id in the page, a
 * limit above 100 rejected). Requests are logged per NSID.
 *
 * `unreadable` makes a room's message fetch throw, as an unreadable room does.
 */
function fakeSpace(rooms: FakeRoom[]) {
  const unreadable = new Set<string>();
  const messageCalls: Array<{ roomId: string; limit: number; cursor?: string }> = [];
  const boardCalls: Array<{ spaceId: string; cursor?: string }> = [];

  /** The board's cursor for a room: "<activity time>::<room id>". */
  const cursorOf = (room: FakeRoom) => `0::${room.id}`;

  const boardRoom = (room: FakeRoom) => {
    const latest = room.messages.at(-1);
    return {
      id: room.id,
      kind: "channel" as const,
      name: room.name,
      activity: {
        latestMembers: [] as never[],
        ...(latest
          ? {
              latestTimestamp: "2026-01-01T00:00:00.000Z",
              latestMessage: {
                id: latest,
                content: "…",
                author: { did: "did:plc:author" },
                timestamp: "2026-01-01T00:00:00.000Z",
              },
            }
          : {}),
      },
    };
  };

  const xrpc = {
    query: async (nsid: string, params: Record<string, string | undefined>) => {
      if (nsid === "space.roomy.space.getThreads") {
        boardCalls.push({ spaceId: params.spaceId!, cursor: params.cursor });
        const limit = Number(params.limit ?? "50");
        const start = params.cursor
          ? rooms.findIndex((r) => cursorOf(r) === params.cursor) + 1
          : 0;
        const page = rooms.slice(start, start + limit);
        const more = start + limit < rooms.length;
        return {
          rooms: page.map(boardRoom),
          ...(more ? { cursor: cursorOf(page[page.length - 1]!) } : {}),
        };
      }

      if (nsid === "space.roomy.room.getMessages") {
        const limit = Number(params.limit ?? "50");
        if (limit > MAX_PAGE_LIMIT) {
          throw new Error(`Param limit must be ≤ 100, got: ${limit}`);
        }
        const roomId = params.roomId!;
        messageCalls.push({ roomId, limit, cursor: params.cursor });
        if (unreadable.has(roomId)) throw new Error(`Room not found: ${roomId}`);
        const room = rooms.find((r) => r.id === roomId);
        if (!room) throw new Error(`Room not found: ${roomId}`);
        const page = room.messages
          .filter((m) => !params.cursor || m < params.cursor)
          .slice(-limit);
        return {
          messages: page.map((m) => ({
            id: m,
            authorDid: "did:plc:author",
            authorName: "Author",
            content: `message ${m}`,
            timestamp: "2026-01-01T00:00:00.000Z",
            mimeType: "text/markdown",
          })),
          cursor: page.length === limit ? page[0] : undefined,
        };
      }

      throw new Error(`unexpected query: ${nsid}`);
    },
  } as never;

  return { rooms, unreadable, messageCalls, boardCalls, xrpc };
}

/** A room of `count` messages, ids ascending with time. */
const roomOf = (roomId: string, name: string, count: number): FakeRoom => ({
  id: roomId,
  name,
  messages: Array.from({ length: count }, (_, i) => id(i + 1)),
});

const opts = (
  cacheDir: string,
  over: Partial<ExportOptions> = {},
): ExportOptions => ({
  spaceId: "space:test",
  account: "did:plc:alice",
  cacheDir,
  ...over,
});

// ── export ─────────────────────────────────────────────────────────────────

describe("collectExport", () => {
  test("exports every channel and thread of the space: N messages, N rows", async () => {
    const space = fakeSpace([
      roomOf("room:a", "general", 5),
      roomOf("room:b", "random", 3),
      roomOf("thread:c", "a thread", 2),
    ]);
    const cacheDir = await cacheDirOf();

    const result = await collectExport(space.xrpc, opts(cacheDir));

    expect(result.rows).toHaveLength(10);
    expect(result.fetched).toBe(10);
    expect(result.cached).toBe(0);
    expect(space.messageCalls.map((c) => c.roomId).sort()).toEqual([
      "room:a",
      "room:b",
      "thread:c",
    ]);
    expect(Math.max(...space.messageCalls.map((c) => c.limit))).toBeLessThanOrEqual(
      MAX_PAGE_LIMIT,
    );
    // Each room's rows are contiguous and ascending; the thread's come last.
    expect(result.rows.map((r) => `${r.roomId}:${r.id}`)).toEqual([
      `room:a:${id(1)}`,
      `room:a:${id(2)}`,
      `room:a:${id(3)}`,
      `room:a:${id(4)}`,
      `room:a:${id(5)}`,
      `room:b:${id(1)}`,
      `room:b:${id(2)}`,
      `room:b:${id(3)}`,
      `thread:c:${id(1)}`,
      `thread:c:${id(2)}`,
    ]);
    expect(result.rows[0]!.roomName).toBe("general");
  });

  test("an unchanged room costs NO getMessages call on a re-run", async () => {
    const space = fakeSpace([roomOf("room:a", "general", 150)]);
    const cacheDir = await cacheDirOf();

    const first = await collectExport(space.xrpc, opts(cacheDir));
    expect(first.rows).toHaveLength(150);
    // 100 + 50: two pages, the second short and cursorless.
    expect(space.messageCalls).toHaveLength(2);

    space.messageCalls.length = 0;
    const second = await collectExport(space.xrpc, opts(cacheDir));

    // The store is complete and its newest row is the board's newest message
    // for the room, so the re-run asks the server nothing.
    expect(space.messageCalls).toHaveLength(0);
    expect(second.rows).toEqual(first.rows);
    expect(second.cached).toBe(150);
    expect(second.fetched).toBe(0);
  });

  test("--refresh re-issues the requests the cached run skipped", async () => {
    const space = fakeSpace([roomOf("room:a", "general", 150)]);
    const cacheDir = await cacheDirOf();

    await collectExport(space.xrpc, opts(cacheDir));
    space.messageCalls.length = 0;

    const refreshed = await collectExport(space.xrpc, opts(cacheDir, { refresh: true }));

    expect(space.messageCalls).toHaveLength(2);
    expect(space.messageCalls[0]!.cursor).toBeUndefined();
    expect(space.messageCalls[1]!.cursor).toBe(id(51));
    expect(refreshed.rows).toHaveLength(150);
    expect(refreshed.fetched).toBe(150);
    expect(refreshed.cached).toBe(0);
  });

  test("a room with new messages fetches only the new ones", async () => {
    const space = fakeSpace([roomOf("room:a", "general", 150)]);
    const cacheDir = await cacheDirOf();

    const first = await collectExport(space.xrpc, opts(cacheDir));
    space.rooms[0]!.messages.push(id(151), id(152), id(153));
    space.messageCalls.length = 0;

    const second = await collectExport(space.xrpc, opts(cacheDir));

    // ONE request: the newest page holds the three new messages and reaches
    // id(150), which is stored.
    expect(space.messageCalls).toHaveLength(1);
    expect(second.fetched).toBe(3);
    expect(second.cached).toBe(150);
    expect(second.rows.map((r) => r.id)).toEqual(
      first.rows.map((r) => r.id).concat([id(151), id(152), id(153)]),
    );
  });

  test("a room that gained more than a page resumes across pages to the stored id", async () => {
    const space = fakeSpace([roomOf("room:a", "general", 100)]);
    const cacheDir = await cacheDirOf();

    await collectExport(space.xrpc, opts(cacheDir));
    // 150 new messages: the catch-up walk needs two pages, reaching id(100) on
    // the second.
    for (let n = 101; n <= 250; n++) space.rooms[0]!.messages.push(id(n));
    space.messageCalls.length = 0;

    const second = await collectExport(space.xrpc, opts(cacheDir));

    expect(space.messageCalls).toHaveLength(2);
    expect(space.messageCalls[1]!.cursor).toBe(id(151));
    expect(second.fetched).toBe(150);
    expect(second.rows).toHaveLength(250);
    expect(second.rows.at(-1)!.id).toBe(id(250));
  });

  test("a room whose whole history is new walks every page", async () => {
    const space = fakeSpace([roomOf("room:a", "general", 250)]);
    const cacheDir = await cacheDirOf();

    const result = await collectExport(space.xrpc, opts(cacheDir));

    expect(result.rows).toHaveLength(250);
    // 100 + 100 + 50: the last page is short and carries no cursor.
    expect(space.messageCalls.map((c) => c.limit)).toEqual([100, 100, 100]);
    expect(space.messageCalls[2]!.cursor).toBe(id(51));
  });

  test("--limit caps per room, newest first, and shrinks the request", async () => {
    const space = fakeSpace([roomOf("room:a", "general", 500)]);
    const cacheDir = await cacheDirOf();

    const result = await collectExport(space.xrpc, opts(cacheDir, { limit: 5 }));

    expect(result.rows.map((r) => r.id)).toEqual([496, 497, 498, 499, 500].map(id));
    expect(space.messageCalls).toHaveLength(1);
    expect(space.messageCalls[0]!.limit).toBe(5);
  });

  test("a capped run over a large room stops at the cap instead of walking the history", async () => {
    const space = fakeSpace([roomOf("room:a", "general", 5_000)]);
    const cacheDir = await cacheDirOf();

    const result = await collectExport(space.xrpc, opts(cacheDir, { limit: 250 }));

    // 100 + 100 + 50 and then stop: the cap, not the room, ends the walk.
    expect(space.messageCalls.map((c) => c.limit)).toEqual([100, 100, 50]);
    expect(result.rows).toHaveLength(250);
    expect(result.rows[0]!.id).toBe(id(4751));
    expect(result.rows.at(-1)!.id).toBe(id(5000));
  });

  test("a capped run is not mistaken for a complete history by a later uncapped run", async () => {
    const space = fakeSpace([roomOf("room:a", "general", 300)]);
    const cacheDir = await cacheDirOf();

    // The capped run stores the newest 20 rows, which include the room's newest
    // message — the same id an uncapped run would see.
    const capped = await collectExport(space.xrpc, opts(cacheDir, { limit: 20 }));
    expect(capped.rows).toHaveLength(20);
    expect(capped.rows.at(-1)!.id).toBe(id(300));

    space.messageCalls.length = 0;
    const full = await collectExport(space.xrpc, opts(cacheDir));

    // The uncapped run must not read the twenty as the room's history: it walks
    // the room and exports all 300.
    expect(full.rows).toHaveLength(300);
    expect(full.rows[0]!.id).toBe(id(1));
    expect(space.messageCalls.length).toBeGreaterThan(0);
  });

  test("a capped run over a stored complete history answers from the store", async () => {
    const space = fakeSpace([roomOf("room:a", "general", 40)]);
    const cacheDir = await cacheDirOf();

    await collectExport(space.xrpc, opts(cacheDir));
    space.messageCalls.length = 0;

    const capped = await collectExport(space.xrpc, opts(cacheDir, { limit: 5 }));

    expect(space.messageCalls).toHaveLength(0);
    expect(capped.rows.map((r) => r.id)).toEqual([36, 37, 38, 39, 40].map(id));
  });

  test("--room exports one room and learns its newest message from the board", async () => {
    const space = fakeSpace([
      roomOf("room:a", "general", 4),
      roomOf("room:b", "random", 4),
    ]);
    const cacheDir = await cacheDirOf();

    const result = await collectExport(space.xrpc, opts(cacheDir, { roomId: "room:b" }));

    expect(result.rooms.map((r) => r.id)).toEqual(["room:b"]);
    expect(space.messageCalls.map((c) => c.roomId)).toEqual(["room:b"]);
    expect(result.rows.map((r) => `${r.roomId}:${r.id}`)).toEqual([
      `room:b:${id(1)}`,
      `room:b:${id(2)}`,
      `room:b:${id(3)}`,
      `room:b:${id(4)}`,
    ]);
    expect(result.rows[0]!.roomName).toBe("random");
  });

  test("--room for a room the board does not list still attempts it", async () => {
    const space = fakeSpace([roomOf("room:a", "general", 2)]);
    const cacheDir = await cacheDirOf();

    const result = await collectExport(
      space.xrpc,
      opts(cacheDir, { roomId: "room:hidden" }),
    );

    expect(result.failed.map((r) => r.id)).toEqual(["room:hidden"]);
  });

  test("a room that cannot be read is skipped and reported, not fatal", async () => {
    const space = fakeSpace([
      roomOf("room:a", "general", 3),
      roomOf("room:b", "gone", 2),
    ]);
    space.unreadable.add("room:b");
    const cacheDir = await cacheDirOf();
    const lines: string[] = [];

    const result = await collectExport(
      space.xrpc,
      opts(cacheDir, { onProgress: (line) => lines.push(line) }),
    );

    expect(result.failed.map((r) => r.id)).toEqual(["room:b"]);
    expect(result.rows.map((r) => r.roomId)).toEqual(["room:a", "room:a", "room:a"]);
    expect(lines.some((l) => l.includes("skipped"))).toBe(true);
  });

  test("a skipped room keeps the rows it already had, for the next run", async () => {
    const space = fakeSpace([roomOf("room:a", "general", 3)]);
    const cacheDir = await cacheDirOf();

    await collectExport(space.xrpc, opts(cacheDir));
    // --refresh forces a walk of a room whose stored rows are already good;
    // that walk is what the room fails at.
    space.unreadable.add("room:a");

    const skipped = await collectExport(space.xrpc, opts(cacheDir, { refresh: true }));
    expect(skipped.failed.map((r) => r.id)).toEqual(["room:a"]);
    expect(skipped.rows).toHaveLength(0);

    // The failed run left the room's file exactly as it was, so a later
    // successful run answers from it without a request.
    space.unreadable.delete("room:a");
    space.messageCalls.length = 0;
    const back = await collectExport(space.xrpc, opts(cacheDir));
    expect(back.fetched).toBe(0);
    expect(back.rows).toHaveLength(3);
  });

  test("a room whose stored rows the server no longer has is not echoed back", async () => {
    const space = fakeSpace([roomOf("room:a", "general", 5)]);
    const cacheDir = await cacheDirOf();

    await collectExport(space.xrpc, opts(cacheDir));
    // The room is emptied and only a new message exists: none of the stored ids
    // are on the server any more, so the walk finds no stored id and must
    // terminate on its own, reporting what the room actually holds.
    space.rooms[0]!.messages = [id(900)];
    space.messageCalls.length = 0;

    const second = await collectExport(space.xrpc, opts(cacheDir));

    expect(space.messageCalls).toHaveLength(1);
    expect(second.rows.map((r) => r.id)).toEqual([id(900)]);
  });

  test("rows of two different spaces live in separate stores", async () => {
    const cacheDir = await cacheDirOf();
    const a = fakeSpace([roomOf("room:a", "general", 2)]);
    const b = fakeSpace([roomOf("room:b", "other", 3)]);

    await collectExport(a.xrpc, opts(cacheDir));
    await collectExport(b.xrpc, opts(cacheDir, { spaceId: "space:other" }));

    a.messageCalls.length = 0;
    b.messageCalls.length = 0;
    await collectExport(a.xrpc, opts(cacheDir));
    await collectExport(b.xrpc, opts(cacheDir, { spaceId: "space:other" }));
    expect(a.messageCalls).toHaveLength(0);
    expect(b.messageCalls).toHaveLength(0);
  });

  test("the store is account-scoped: another DID's cache is refetched", async () => {
    const space = fakeSpace([roomOf("room:a", "general", 40)]);
    const cacheDir = await cacheDirOf();

    await collectExport(space.xrpc, opts(cacheDir));
    space.messageCalls.length = 0;

    // A different viewer reads the same directory. The snapshot carries the DID
    // it was written for, so none of the first viewer's rows are reused.
    const other = await collectExport(
      space.xrpc,
      opts(cacheDir, { account: "did:plc:bob" }),
    );
    expect(space.messageCalls).toHaveLength(1);
    expect(other.fetched).toBe(40);
    expect(other.cached).toBe(0);
  });
});

/**
 * Minimal RFC 4180 reader for the assertions above: splits rows on CRLF
 * outside quotes, undoubling quotes and unwrapping quoted fields.
 */
function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let fields: string[] = [];
  let field = "";
  let quoted = false;
  const endField = () => {
    fields.push(field);
    field = "";
  };
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i]!;
    if (quoted) {
      if (ch === '"') {
        if (csv[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") endField();
    else if (ch === "\r" && csv[i + 1] === "\n") {
      endField();
      rows.push(fields);
      fields = [];
      i++;
    } else field += ch;
  }
  return rows;
}
