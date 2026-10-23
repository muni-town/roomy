/**
 * The two message extensions that carry authority require space admin, over
 * the real HTTP write path.
 *
 * `authorOverride` replaces the DID the materialiser writes as the message's
 * author, and `timestampOverride` replaces its canonical ordering time — the
 * input to `sort_idx`. Neither was looked at by write authorization, so any
 * member with write access to a room could post as any DID (including an
 * admin's) and place the result anywhere in the timeline.
 *
 * These tests drive `sendEvents` as a plain member and as an admin, then read
 * the room back the way a client does: the denial is the wire contract, and
 * the read is what proves nothing was written and nothing was moved.
 *
 * Run: bun test --cwd packages/appserver src/e2e/extensionAuthority.test.ts
 */

import { describe, expect, test } from "bun:test";
import { newUlid } from "@roomy-space/sdk";
import { decodeTime } from "ulidx";
import {
  materializeSpace,
  seedJoinedSpace,
  seedMembership,
  seedSpace,
  startAppserver,
  type E2eContext,
} from "./helpers.ts";

const ADMIN = "did:plc:extension-authority-admin";
const MEMBER = "did:plc:extension-authority-member";
const SPACE = "did:web:space-extension-authority.example";
/** The DID a member would impersonate with `authorOverride`. */
const IMPERSONATED = "did:plc:somebody-else-entirely";

const AUTHOR_OVERRIDE = "space.roomy.extension.authorOverride.v0";
const TIMESTAMP_OVERRIDE = "space.roomy.extension.timestampOverride.v0";

interface MessageRow {
  id: string;
  authorDid: string;
  sort_idx?: string;
  timestamp: string;
}

function bodyBytes(text: string): { mimeType: string; data: { $bytes: string } } {
  return {
    mimeType: "text/plain",
    data: { $bytes: Buffer.from(text).toString("base64") },
  };
}

/** A createMessage carrying exactly `extensions`. */
function messageEvent(
  roomId: string,
  text: string,
  extensions: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: newUlid(),
    room: roomId,
    $type: "space.roomy.message.createMessage.v0",
    body: bodyBytes(text),
    extensions,
  };
}

/** POST one batch as `did`; returns the raw response so the status is assertable. */
async function send(
  ctx: E2eContext,
  did: string,
  events: Record<string, unknown>[],
): Promise<Response> {
  return ctx.authedFetch(did)(
    `${ctx.baseUrl}/xrpc/space.roomy.space.sendEvents`,
    { method: "POST", body: JSON.stringify({ spaceId: SPACE, events }) },
  );
}

async function getMessages(
  ctx: E2eContext,
  did: string,
  roomId: string,
): Promise<MessageRow[]> {
  const res = await ctx.authedFetch(did)(
    `${ctx.baseUrl}/xrpc/space.roomy.room.getMessages?roomId=${roomId}&limit=100`,
  );
  if (res.status !== 200) throw new Error(`getMessages ${res.status}`);
  const body = (await res.json()) as { messages: MessageRow[] };
  // `selectMessages` returns oldest → newest.
  return body.messages;
}

/**
 * A space where `ADMIN` is admin and `MEMBER` is a plain member with write
 * access to a fresh channel, which is the shape the vulnerability needed.
 */
async function fixture(
  ctx: E2eContext,
): Promise<{ roomId: string }> {
  seedSpace(ctx.db, SPACE, ADMIN, { allowPublicJoin: 0 });
  seedJoinedSpace(ctx.db, MEMBER, SPACE);
  seedMembership(ctx.db, SPACE, MEMBER, "member");
  const { roomId } = await materializeSpace(ctx, SPACE, ADMIN, {
    roomName: "general",
    messageText: "seed",
  });
  return { roomId };
}

describe("author/timestamp overrides are space-admin only", () => {
  test("a member's authorOverride is refused and nothing is written", async () => {
    const ctx = await startAppserver();
    const { roomId } = await fixture(ctx);
    const before = await getMessages(ctx, MEMBER, roomId);

    const res = await send(ctx, MEMBER, [
      messageEvent(roomId, "I am someone else", {
        [AUTHOR_OVERRIDE]: { $type: AUTHOR_OVERRIDE, did: IMPERSONATED },
      }),
    ]);

    expect(res.status).toBe(403);
    const problem = (await res.json()) as { message?: string };
    // The denial names the extension, so a client can tell it apart from a
    // plain room-write refusal.
    expect(problem.message).toContain("authorOverride");

    const after = await getMessages(ctx, MEMBER, roomId);
    expect(after).toHaveLength(before.length);
    expect(after.some((m) => m.authorDid === IMPERSONATED)).toBe(false);
  });

  test("a member's timestampOverride is refused", async () => {
    const ctx = await startAppserver();
    const { roomId } = await fixture(ctx);
    const before = await getMessages(ctx, MEMBER, roomId);

    const res = await send(ctx, MEMBER, [
      messageEvent(roomId, "backdated", {
        [TIMESTAMP_OVERRIDE]: {
          $type: TIMESTAMP_OVERRIDE,
          timestamp: Date.now() - 86_400_000,
        },
      }),
    ]);

    expect(res.status).toBe(403);
    expect(((await res.json()) as { message?: string }).message).toContain(
      "timestampOverride",
    );
    expect(await getMessages(ctx, MEMBER, roomId)).toHaveLength(before.length);
  });

  test("an admin's authorOverride is written and read back as the override", async () => {
    const ctx = await startAppserver();
    const { roomId } = await fixture(ctx);

    const event = messageEvent(roomId, "bridged in", {
      [AUTHOR_OVERRIDE]: { $type: AUTHOR_OVERRIDE, did: IMPERSONATED },
    });
    expect((await send(ctx, ADMIN, [event])).status).toBe(200);

    const rows = await getMessages(ctx, ADMIN, roomId);
    const written = rows.find((m) => m.id === event.id);
    expect(written).toBeDefined();
    expect(written!.authorDid).toBe(IMPERSONATED);
  });

  test("an admin's timestampOverride is written and keys sort_idx", async () => {
    const ctx = await startAppserver();
    const { roomId } = await fixture(ctx);

    const originalAt = Date.now() - 48 * 60 * 60 * 1000;
    const event = messageEvent(roomId, "two days ago", {
      [TIMESTAMP_OVERRIDE]: { $type: TIMESTAMP_OVERRIDE, timestamp: originalAt },
    });
    expect((await send(ctx, ADMIN, [event])).status).toBe(200);

    const rows = await getMessages(ctx, ADMIN, roomId);
    const written = rows.find((m) => m.id === event.id);
    expect(written).toBeDefined();
    // The override wins over the receipt time in the timeline key...
    expect(decodeTime(written!.sort_idx!)).toBe(originalAt);
    // ...and behind the seed message, which was written first.
    expect(rows.findIndex((m) => m.id === event.id)).toBe(0);
  });

  test("an ordinary member send still succeeds", async () => {
    const ctx = await startAppserver();
    const { roomId } = await fixture(ctx);

    const event = messageEvent(roomId, "hello");
    expect((await send(ctx, MEMBER, [event])).status).toBe(200);

    const rows = await getMessages(ctx, MEMBER, roomId);
    const written = rows.find((m) => m.id === event.id);
    expect(written).toBeDefined();
    // No override: the author is the caller, as before the gate.
    expect(written!.authorDid).toBe(MEMBER);
  });

  test("a member may still send presentation extensions", async () => {
    // Attachments and mentions carry no authority; gating them would break
    // ordinary sends.
    const ctx = await startAppserver();
    const { roomId } = await fixture(ctx);

    const event = messageEvent(roomId, "look at this", {
      "space.roomy.extension.attachments.v0": {
        $type: "space.roomy.extension.attachments.v0",
        attachments: [
          {
            $type: "space.roomy.attachment.link.v0",
            uri: "https://example.test",
            showPreview: true,
          },
        ],
      },
      "space.roomy.extension.mentions.v0": {
        $type: "space.roomy.extension.mentions.v0",
        mentions: [ADMIN],
      },
    });
    expect((await send(ctx, MEMBER, [event])).status).toBe(200);
    expect(
      (await getMessages(ctx, MEMBER, roomId)).some((m) => m.id === event.id),
    ).toBe(true);
  });

  test("one refused event refuses the whole batch", async () => {
    // Authorization runs before any write, so a mixed batch leaves nothing
    // behind — the member's own message must not land beside the refused one.
    const ctx = await startAppserver();
    const { roomId } = await fixture(ctx);
    const before = await getMessages(ctx, MEMBER, roomId);

    const own = messageEvent(roomId, "mine");
    const impersonated = messageEvent(roomId, "not mine", {
      [AUTHOR_OVERRIDE]: { $type: AUTHOR_OVERRIDE, did: IMPERSONATED },
    });
    expect((await send(ctx, MEMBER, [own, impersonated])).status).toBe(403);

    expect(await getMessages(ctx, MEMBER, roomId)).toHaveLength(before.length);
  });
});
