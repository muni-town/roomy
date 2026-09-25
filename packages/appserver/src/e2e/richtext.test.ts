/**
 * E2E smoke test for the rich-text (blocks+facets) message path.
 *
 * Exercises the full wire round-trip through the real HTTP transport:
 *   1. `space.roomy.space.sendEvents` with a new-format createMessage
 *      (`application/vnd.roomy.richtext+json` body carrying #link and
 *      #didMention facets).
 *   2. Materialization: the message row + link entity are stored.
 *   3. `space.roomy.room.getMessages` returns the message with the new
 *      `mimeType` and base64-encoded JSON content (decodeContent base64s
 *      non-text mimeTypes — the client base64-decodes, then JSON.parses).
 *
 * Run: bun test --cwd packages/appserver src/e2e/richtext.test.ts
 */
import { describe, expect, test } from "bun:test";
import { newUlid, toBytes } from "@roomy-space/sdk";
import {
  startAppserver,
  seedSpace,
  seedRoom,
  seedJoinedSpace,
  seedMessage,
  type E2eContext,
} from "./helpers.ts";

const USER = "did:plc:e2e-richtext-user";
const SPACE = "did:web:space-richtext-e2e.example";
const ROOM = newUlid();

/** Seed a space + room so the user can send into it. */
async function setup(): Promise<E2eContext> {
  const ctx = await startAppserver();
  const { db } = ctx;
  seedSpace(db, SPACE, USER);
  seedJoinedSpace(db, USER, SPACE);
  seedRoom(db, ROOM, SPACE);
  return ctx;
}

/** Build a new-format createMessage event body from blocks. */
function richtextEvent(text: string) {
  const blocks = [
    {
      $type: "space.roomy.richtext.blocks#text",
      text,
      facets: [
        {
          index: { byteStart: 0, byteEnd: text.length },
          features: [
            {
              $type: "space.roomy.richtext.facet#link",
              uri: "https://example.com/richtext-smoke",
            },
            {
              $type: "space.roomy.richtext.facet#didMention",
              did: "did:plc:mentioned-user",
            },
          ],
        },
      ],
    },
  ];
  return {
    id: newUlid(),
    room: ROOM,
    $type: "space.roomy.message.createMessage.v0",
    body: {
      mimeType: "application/vnd.roomy.richtext+json",
      data: toBytes(
        new TextEncoder().encode(
          JSON.stringify({
            $type: "space.roomy.richtext.document",
            blocks,
          }),
        ),
      ),
    },
    extensions: {},
  };
}

describe("rich text message E2E", () => {
  test("new-format message round-trips through sendEvents + getMessages", async () => {
    const ctx = await setup();
    const event = richtextEvent("hello @alice https://example.com/richtext-smoke");

    const sendRes = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.sendEvents`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spaceId: SPACE, events: [event] }),
      },
    );
    expect(sendRes.status).toBe(200);

    const getRes = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.room.getMessages?roomId=${ROOM}`,
    );
    expect(getRes.status).toBe(200);
    const body = await getRes.json();
    const msgs = (body.messages ?? []) as Array<{
      id: string;
      content: string;
      mimeType?: string;
    }>;
    const created = msgs.find((m) => m.id === event.id);
    expect(created).toBeDefined();
    expect(created!.mimeType).toBe("application/vnd.roomy.richtext+json");
    // Content is base64-encoded JSON (decodeContent base64s non-text mimeTypes).
    const decoded = JSON.parse(Buffer.from(created!.content, "base64").toString("utf8"));
    expect(decoded.$type).toBe("space.roomy.richtext.document");
    expect(decoded.blocks).toHaveLength(1);
    expect(decoded.blocks[0].text).toContain("https://example.com/richtext-smoke");
  });

  test("link facet URL is materialized into comp_embed_link", async () => {
    const ctx = await setup();
    const event = richtextEvent("check https://example.com/richtext-smoke");
    const sendRes = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.sendEvents`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spaceId: SPACE, events: [event] }),
      },
    );
    expect(sendRes.status).toBe(200);

    // The link entity row should exist (message_id = the link entity's room).
    // comp_embed_link lives in the per-space DB.
    const row = await (ctx.db as unknown as { forSpace(s: string): { query(q: string): { get<T>(...p: unknown[]): Promise<T | null> } } })
      .forSpace(SPACE)
      .query("select ei.entity from comp_embed_link ei where ei.entity = ?")
      .get<{ entity: string }>(event.id);
    expect(row).toBeDefined();
  });

  test("legacy (non-richtext) message round-trips without richtext mimeType", async () => {
    const ctx = await setup();
    // Seed a legacy message directly — seedMessage uses text/html.
    const legacyId = newUlid();
    seedMessage(ctx.db, legacyId, ROOM, SPACE, "legacy");

    const getRes = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.room.getMessages?roomId=${ROOM}`,
    );
    expect(getRes.status).toBe(200);
    const body = await getRes.json();
    const msgs = (body.messages ?? []) as Array<{ id: string; mimeType?: string; content: string }>;
    const legacy = msgs.find((m) => m.id === legacyId);
    expect(legacy).toBeDefined();
    expect(legacy!.mimeType).toBe("text/html");
    // Content comes through as plain text (decodeContent decodes text/*).
    expect(legacy!.content).toBe("<p>hello</p>");
  });
});
