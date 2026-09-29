/**
 * The timeline's ordering key is the SERVER's time, not the sender's.
 *
 * A `createMessage` event id is a ULID the sender's device minted, so it
 * encodes the sender's clock. `entities.sort_idx` is what `room.getMessages`
 * pages on, so keying it on that ULID let one skewed device place its message
 * in the middle of everyone else's history — durably, since the key is written
 * once. A `timestampOverride` extension is the one deliberate exception: a
 * producer translating another system's timeline (the Discord bridge) knows
 * the real order, and that must keep winning.
 *
 * Run: bun test --cwd packages/appserver src/e2e/messageSortIdx.test.ts
 */

import { describe, expect, test } from "bun:test";
import { newUlid } from "@roomy-space/sdk";
import { decodeTime, ulid } from "ulidx";
import { materializeSpace, startAppserver, type E2eContext } from "./helpers.ts";

const USER = "did:plc:message-sort-idx-user";
const SPACE = "did:web:space-message-sort-idx.example";

const HOUR_MS = 60 * 60 * 1000;

interface MessageRow {
  id: string;
  sort_idx?: string;
  timestamp: string;
}

async function sendEvent(
  ctx: E2eContext,
  event: Record<string, unknown>,
): Promise<string> {
  const res = await ctx.authedFetch(USER)(
    `${ctx.baseUrl}/xrpc/space.roomy.space.sendEvents`,
    { method: "POST", body: JSON.stringify({ spaceId: SPACE, events: [event] }) },
  );
  if (res.status !== 200) throw new Error(`${res.status}: ${await res.text()}`);
  return event.id as string;
}

/** A createMessage carrying `overrideTimestamp` when given. */
function createMessageEvent(
  roomId: string,
  id: string,
  text: string,
  overrideTimestamp?: number,
): Record<string, unknown> {
  return {
    id,
    room: roomId,
    $type: "space.roomy.message.createMessage.v0",
    body: {
      mimeType: "text/plain",
      data: { $bytes: Buffer.from(text).toString("base64") },
    },
    extensions:
      overrideTimestamp === undefined
        ? {}
        : {
            "space.roomy.extension.timestampOverride.v0": {
              $type: "space.roomy.extension.timestampOverride.v0",
              timestamp: overrideTimestamp,
            },
          },
  };
}

/** The room's timeline, oldest → newest as the appserver pages it. */
async function getMessages(
  ctx: E2eContext,
  roomId: string,
): Promise<MessageRow[]> {
  const res = await ctx.authedFetch(USER)(
    `${ctx.baseUrl}/xrpc/space.roomy.room.getMessages?roomId=${roomId}&limit=50`,
  );
  if (res.status !== 200) throw new Error(`getMessages ${res.status}`);
  const body = (await res.json()) as { messages: MessageRow[] };
  return body.messages;
}

describe("message sort key", () => {
  test("a message whose ULID is hours old still sorts newest in its room", async () => {
    const ctx = await startAppserver();
    const { roomId, messageId: first } = await materializeSpace(ctx, SPACE, USER, {
      roomName: "general",
      messageText: "first",
    });

    const second = await sendEvent(
      ctx,
      createMessageEvent(roomId, newUlid(), "second"),
    );

    // The skew: this event's ULID decodes to six hours ago, the way a client
    // whose clock is behind would mint it. It is the newest message.
    const before = Date.now();
    const skewed = ulid(before - 6 * HOUR_MS);
    const third = await sendEvent(ctx, createMessageEvent(roomId, skewed, "third"));

    const rows = await getMessages(ctx, roomId);
    expect(rows.map((r) => r.id)).toEqual([first, second, third]);

    // ... and its ordering key is the server's arrival time, not that ULID.
    const key = decodeTime(rows[2]!.sort_idx!);
    expect(key).toBeGreaterThanOrEqual(before);
    expect(key).toBeLessThanOrEqual(Date.now());
  });

  test("a bridged message sorts by its timestampOverride, not by arrival", async () => {
    const ctx = await startAppserver();
    const { roomId, messageId: native } = await materializeSpace(ctx, SPACE, USER, {
      roomName: "bridged",
      messageText: "native",
    });

    // Ingested now (fresh ULID), but the original message is two days old —
    // the Discord bridge's shape. It must land behind the native message.
    const originalAt = Date.now() - 48 * HOUR_MS;
    const bridged = await sendEvent(
      ctx,
      createMessageEvent(roomId, newUlid(), "from discord", originalAt),
    );

    const rows = await getMessages(ctx, roomId);
    expect(rows.map((r) => r.id)).toEqual([bridged, native]);
    expect(decodeTime(rows[0]!.sort_idx!)).toBe(originalAt);
  });
});
