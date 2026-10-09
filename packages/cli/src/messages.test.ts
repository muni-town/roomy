import { describe, expect, test } from "bun:test";
import { MAX_PAGE_LIMIT, readMessagePage, readMessages, sendMessage } from "./messages.js";

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

/**
 * `send --parent <id>` attaches a reply to a message. The appserver refuses
 * the WHOLE sendEvents batch when the target is not a message (a room, a
 * thread, a page), so a room id passed as `--parent` used to cost a full turn:
 * nothing was sent, and the only signal was a 400 naming an id the caller
 * believed was a message.
 *
 * The fake reproduces both halves of the appserver's contract: `getMessage`
 * resolves only messages (400 for anything else, 404 for nothing), and
 * `sendEvents` refuses a reply whose target is not one. A test that stubbed
 * the rejection away would pass against the unfixed code.
 */
function fakeMessages() {
  const messages = new Set<string>(["01MSG"]);
  const sent: { events: unknown[] }[] = [];
  const xrpc = {
    async query(nsid: string, params: { messageId: string }) {
      if (nsid !== "space.roomy.message.getMessage") {
        throw new Error(`unexpected query: ${nsid}`);
      }
      if (!messages.has(params.messageId)) {
        const err = new Error(`Entity ${params.messageId} is not a message (no room)`);
        Object.assign(err, { status: 400 });
        throw err;
      }
      return { id: params.messageId };
    },
    async procedure(nsid: string, params: { events: unknown[] }) {
      if (nsid !== "space.roomy.space.sendEvents") {
        throw new Error(`unexpected procedure: ${nsid}`);
      }
      // Server-side reply-target validation, mirrored (writeAuth.ts): a reply
      // whose target is not a message rejects the whole batch.
      for (const event of params.events) {
        const target = replyTargetOf(event);
        if (target !== undefined && !messages.has(target)) {
          const err = new Error(`Reply target ${target} is not a message (no room)`);
          Object.assign(err, { status: 400 });
          throw err;
        }
      }
      sent.push({ events: params.events });
      return {};
    },
  } as never;
  return { xrpc, sent };
}

/** The reply target an event carries, or undefined when it is not a reply. */
function replyTargetOf(event: unknown): string | undefined {
  if (typeof event !== "object" || event === null || !("extensions" in event)) {
    return undefined;
  }
  const extensions = event.extensions;
  if (typeof extensions !== "object" || extensions === null) return undefined;
  const ext = (extensions as Record<string, unknown>)["space.roomy.extension.attachments.v0"];
  if (typeof ext !== "object" || ext === null || !("attachments" in ext)) return undefined;
  const attachments = ext.attachments;
  if (!Array.isArray(attachments)) return undefined;
  for (const att of attachments) {
    if (typeof att !== "object" || att === null) continue;
    const a = att as Record<string, unknown>;
    if (a.$type === "space.roomy.attachment.reply.v0" && typeof a.target === "string") {
      return a.target;
    }
  }
  return undefined;
}

describe("sendMessage --parent validation", () => {
  test("a room id is rejected locally, with no sendEvents call", async () => {
    const { xrpc, sent } = fakeMessages();

    await expect(
      sendMessage(xrpc, "space:test", "room:test", "hi", { parent: "room:test" }),
    ).rejects.toThrow(/not a message id — --parent takes a message/);
    expect(sent).toHaveLength(0);
  });

  test("a message id still sends, carrying the reply attachment", async () => {
    const { xrpc, sent } = fakeMessages();

    const { messageId } = await sendMessage(xrpc, "space:test", "room:test", "hi", {
      parent: "01MSG",
    });

    expect(messageId).not.toBe("");
    expect(sent).toHaveLength(1);
    expect(replyTargetOf(sent[0]!.events[0])).toBe("01MSG");
  });

  test("a 404 (no such entity) is a definite negative — rejected locally", async () => {
    const xrpc = {
      async query() {
        const err = new Error("Message not found: 01GONE");
        Object.assign(err, { status: 404 });
        throw err;
      },
      async procedure() {
        throw new Error("sendEvents must not be called");
      },
    } as never;

    await expect(
      sendMessage(xrpc, "space:test", "room:test", "hi", { parent: "01GONE" }),
    ).rejects.toThrow(/not a message id/);
  });

  test("an inconclusive probe does not block the send", async () => {
    // A 403 (a message in a room the caller cannot read) says nothing about
    // whether the target is a message — the appserver stays the authority, so
    // the send proceeds and is left to decide.
    let sendEventsCalls = 0;
    const xrpc = {
      async query() {
        const err = new Error("Caller has no read access to this room");
        Object.assign(err, { status: 403 });
        throw err;
      },
      async procedure(nsid: string) {
        if (nsid === "space.roomy.space.sendEvents") sendEventsCalls += 1;
        return {};
      },
    } as never;

    await sendMessage(xrpc, "space:test", "room:test", "hi", { parent: "01MSG" });

    expect(sendEventsCalls).toBe(1);
  });
});
