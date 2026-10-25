/**
 * A Web Tile attachment's write gate, end to end.
 *
 * The tile's address and its payload are part of the message record, so both
 * are checked where every other record field is: `parseEvent` in the
 * `sendEvents` handler, before anything reaches the event log. A record that
 * fails there is refused whole — an address nothing can load, or a payload
 * larger than the log will carry, costs the caller a 400 rather than becoming
 * a permanent byte range in every replica.
 *
 * The accepted case is here too, because the bound is only meaningful if the
 * value at it still reads back intact.
 */

import { describe, expect, test } from "bun:test";
import { MAX_TILE_DATA_BYTES, newUlid } from "@roomy-space/sdk";
import { materializeSpace, startAppserver, type E2eContext } from "./helpers.ts";

const USER = "did:plc:tile-limits-user";
const SPACE = "did:plc:tile-limits-space";
const TILE = "at://did:plc:ewvi7nxzyoun6zhxrhs64oiz/ing.dasl.masl/3ktile";

/** One `createMessage` carrying a single tile attachment. */
async function sendTile(
  ctx: E2eContext,
  roomId: string,
  attachment: Record<string, unknown>,
) {
  return ctx.authedFetch(USER)(`${ctx.baseUrl}/xrpc/space.roomy.space.sendEvents`, {
    method: "POST",
    body: JSON.stringify({
      spaceId: SPACE,
      events: [
        {
          id: newUlid(),
          $type: "space.roomy.message.createMessage.v0",
          room: roomId,
          body: {
            mimeType: "text/plain",
            data: { $bytes: Buffer.from("a tile").toString("base64") },
          },
          extensions: {
            "space.roomy.extension.attachments.v0": {
              $type: "space.roomy.extension.attachments.v0",
              attachments: [{ $type: "space.roomy.attachment.tile.v0", ...attachment }],
            },
          },
        },
      ],
    }),
  });
}

/** Every message in the room, newest first. */
async function readMessages(ctx: E2eContext, roomId: string) {
  const res = await ctx.authedFetch(USER)(
    `${ctx.baseUrl}/xrpc/space.roomy.room.getMessages?roomId=${roomId}`,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    messages: Array<{ attachments?: Array<Record<string, unknown>> }>;
  };
  return body.messages;
}

describe("a Web Tile attachment is bounded at the write path", () => {
  test("a payload at the bound is stored, and reads back as the tile's address and JSON", async () => {
    const ctx = await startAppserver();
    const { roomId } = await materializeSpace(ctx, SPACE, USER, { roomName: "general" });
    // `JSON.stringify` wraps the string in two quotes, so this is exactly
    // MAX_TILE_DATA_BYTES once serialised.
    const payload = "x".repeat(MAX_TILE_DATA_BYTES - 2);

    const res = await sendTile(ctx, roomId, { uri: TILE, data: payload });
    expect(res.status).toBe(200);

    const carrying = (await readMessages(ctx, roomId)).filter(
      (m) => (m.attachments ?? []).length > 0,
    );
    expect(carrying.map((m) => m.attachments)).toEqual([
      [{ $type: "space.roomy.attachment.tile.v0", url: TILE, data: payload }],
    ]);
  });

  test("a payload one byte past the bound is refused, and no message is written", async () => {
    const ctx = await startAppserver();
    const { roomId } = await materializeSpace(ctx, SPACE, USER, { roomName: "general" });

    const res = await sendTile(ctx, roomId, {
      uri: TILE,
      data: "x".repeat(MAX_TILE_DATA_BYTES - 1),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("InvalidRequest");

    // Nothing was written: the batch is validated whole, before the log.
    const carrying = (await readMessages(ctx, roomId)).filter(
      (m) => (m.attachments ?? []).length > 0,
    );
    expect(carrying).toEqual([]);
  });

  test("an address no loader can resolve is refused", async () => {
    const ctx = await startAppserver();
    const { roomId } = await materializeSpace(ctx, SPACE, USER, { roomName: "general" });

    for (const uri of [
      "https://example.com/tile.html",
      "at://did:plc:ewvi7nxzyoun6zhxrhs64oiz/space.roomy.tile/3ktile",
      "at://did:web:tiles.example/ing.dasl.masl/3ktile",
    ]) {
      const res = await sendTile(ctx, roomId, { uri });
      expect([uri, res.status]).toEqual([uri, 400]);
    }
  });
});
