import { describe, expect, test } from "bun:test";
import { MAX_PAGE_LIMIT, readMessagePage, readMessages } from "./messages.js";

/**
 * Regression coverage for TASK-188: `read --limit N` for N > 100 was a hard
 * 400.
 *
 * Production symptom (reproduced against api.roomy.space): `read --limit 200`
 * answered `XRPC space.roomy.room.getMessages failed (400): Param limit must
 * be ≤ 100, got: 200` — the CLI forwarded the raw value and the appserver
 * bound (`max: 100`, deliberate, unchanged) rejected it. There was also no way
 * to ask for anything older than the newest page.
 *
 * The fake below therefore *reproduces the server's contract*, including the
 * 400: a test that stubs the bound away would pass against the unfixed code.
 */

/** Sortable, ULID-shaped ids: id(1) is the oldest message in the fake room. */
const id = (n: number) => `01M0${String(n).padStart(20, "0")}`;

interface PageCall {
  limit: number;
  cursor?: string;
}

/**
 * A fake appserver exposing exactly one room's history, newest-first with
 * `cursor` meaning "older than this id" — the semantics of
 * `packages/appserver/src/queries/selectMessages.ts`.
 */
function fakeRoom(count: number) {
  const ids = Array.from({ length: count }, (_, i) => id(i + 1));
  const calls: PageCall[] = [];

  const xrpc = {
    query: async (nsid: string, params: Record<string, string | undefined>) => {
      if (nsid !== "space.roomy.room.getMessages") {
        throw new Error(`unexpected query: ${nsid}`);
      }
      const limit = params.limit === undefined ? 50 : Number(params.limit);
      if (limit > 100) {
        throw new Error(
          `XRPC space.roomy.room.getMessages failed (400): ` +
            `Param limit must be ≤ 100, got: ${limit}`,
        );
      }
      calls.push({ limit, cursor: params.cursor });

      // Server semantics (selectMessages): newest-first page selection, but the
      // returned page is ascending (oldest → newest) and the cursor is the
      // OLDEST id in the page.
      const page = ids.filter((m) => !params.cursor || m < params.cursor).slice(-limit);
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
    },
  } as never;

  return { xrpc, calls, ids };
}

describe("readMessages paging", () => {
  test("--limit 250 returns 250 messages across bounded pages, never a 400", async () => {
    const room = fakeRoom(600);

    // Unfixed code forwarded limit=250 as a single request and this threw.
    const { messages, cursor } = await readMessages(room.xrpc, "room:1", {
      limit: 250,
    });

    expect(messages).toHaveLength(250);
    // 100 + 100 + 50: three requests, each within the server's bound.
    expect(room.calls).toHaveLength(3);
    expect(room.calls.map((c) => c.limit)).toEqual([100, 100, 50]);
    expect(Math.max(...room.calls.map((c) => c.limit))).toBeLessThanOrEqual(
      MAX_PAGE_LIMIT,
    );
    // The second page must resume from the first page's cursor, not restart.
    expect(room.calls[1]!.cursor).toBe(id(501));
    expect(room.calls[2]!.cursor).toBe(id(401));

    // The window is the newest 250 messages, ordered oldest → newest.
    expect(messages[0]!.id).toBe(id(351));
    expect(messages.at(-1)!.id).toBe(id(600));
    expect(messages.map((m) => m.id)).toEqual(
      room.ids.slice(-250).sort(),
    );
    // Cursor points past the oldest message returned, so the next read
    // continues exactly where this one stopped.
    expect(cursor).toBe(id(351));
  });

  test("--cursor reads older history without walking from the newest message", async () => {
    const room = fakeRoom(600);

    const { messages, cursor } = await readMessages(room.xrpc, "room:1", {
      limit: 10,
      cursor: id(500),
    });

    expect(messages.map((m) => m.id)).toEqual(
      Array.from({ length: 10 }, (_, i) => id(490 + i)),
    );
    expect(cursor).toBe(id(490));
    expect(room.calls).toHaveLength(1);
    expect(room.calls[0]!.cursor).toBe(id(500));
  });

  test("a room with no older messages reports no cursor", async () => {
    const room = fakeRoom(5);

    const { messages, cursor } = await readMessages(room.xrpc, "room:1", {
      limit: 20,
    });

    expect(messages.map((m) => m.id)).toEqual(room.ids);
    expect(cursor).toBeUndefined();
  });

  test("paging stops when history is exhausted mid-walk", async () => {
    const room = fakeRoom(120);

    const { messages, cursor } = await readMessages(room.xrpc, "room:1", {
      limit: 250,
    });

    // Second page is short (20 of the 100 requested) and carries no cursor,
    // which is what tells the walk the room is exhausted: no third request is
    // issued, and no cursor is reported back.
    expect(messages).toHaveLength(120);
    expect(cursor).toBeUndefined();
    expect(room.calls.map((c) => c.limit)).toEqual([100, 100]);
  });

  test("a single page keeps server ordering and issues exactly one request", async () => {
    const room = fakeRoom(600);

    const { messages, cursor } = await readMessages(room.xrpc, "room:1", {
      limit: 50,
    });

    expect(room.calls).toHaveLength(1);
    expect(messages.map((m) => m.id)).toEqual(room.ids.slice(-50).sort());
    expect(cursor).toBe(id(551));
  });
});

describe("readMessagePage", () => {
  test("clamps a request above the server bound instead of sending it", async () => {
    const room = fakeRoom(600);

    const page = await readMessagePage(room.xrpc, "room:1", { limit: 500 });

    expect(room.calls).toEqual([{ limit: MAX_PAGE_LIMIT, cursor: undefined }]);
    expect(page.messages).toHaveLength(MAX_PAGE_LIMIT);
  });

  test("defaults to the server bound when no limit is given", async () => {
    const room = fakeRoom(600);

    const page = await readMessagePage(room.xrpc, "room:1");

    expect(room.calls[0]!.limit).toBe(MAX_PAGE_LIMIT);
    expect(page.messages).toHaveLength(MAX_PAGE_LIMIT);
  });
});
