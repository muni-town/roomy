/**
 * E2E: a link that resolves to a Web Tile, through the real XRPC handlers.
 *
 * The scenario is the retroactive one. A message links a Bluesky post and was
 * materialised before tiles existed: its link row and its settled OpenGraph
 * embed are in place, and nothing is pending. Reading the room queues the tile
 * half; the sweep resolves it against the AppView; the next read serves the
 * card with `embed.tile` on it.
 *
 * Only the AppView is stubbed. Everything else — the read path, the pending
 * index, the sweeper, the store — is the deployed code.
 */

import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, test } from "bun:test";
import { newUlid } from "@roomy-space/sdk";
import { openGlobalDb } from "../db/db.ts";
import {
  _startSweeperNoLoop,
  stopEmbedSweeper,
  sweepCycle,
} from "../embed/sweeper.ts";
import { TILE_MAPPING } from "../embed/tiles.ts";
import {
  globalDb,
  seedJoinedSpace,
  seedMessage,
  seedRoom,
  seedSpace,
  spaceDb,
  startAppserver,
  type E2eContext,
} from "./helpers.ts";

const SPACE = "did:web:tile-resolution.example";
const OWNER = "did:plc:e2e-tile-owner";
const POST_DID = "did:plc:z72i7hdynmk6r22z27h6tvur";
const POST_URL = `https://bsky.app/profile/${POST_DID}/post/3ke2e`;
const POST_URI = `at://${POST_DID}/app.bsky.feed.post/3ke2e`;

const realFetch = globalThis.fetch;
// Tile resolution is off unless a deployment asks for it; this is the suite of
// what happens when it does.
const realFlag = process.env.EMBED_TILE_RESOLUTION;
beforeAll(() => {
  process.env.EMBED_TILE_RESOLUTION = "on";
});
afterAll(() => {
  if (realFlag === undefined) delete process.env.EMBED_TILE_RESOLUTION;
  else process.env.EMBED_TILE_RESOLUTION = realFlag;
});

/** Route outbound fetches: the AppView answers `getPosts`, the page yields no OG. */
function stubNetwork(): { og: number; appview: number } {
  const calls = { og: 0, appview: 0 };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    // The context's own client reaches the appserver through this same
    // `fetch`, so anything addressed to it must pass through untouched.
    if (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) {
      return realFetch(input, init);
    }
    if (url.includes("app.bsky.feed.getPosts")) {
      calls.appview++;
      return new Response(
        JSON.stringify({
          posts: [
            {
              uri: POST_URI,
              cid: "bafyreie2e",
              author: { did: POST_DID, handle: "bsky.app", displayName: "Bluesky" },
              record: { text: "the post a tile renders", createdAt: "2026-10-20T10:00:00.000Z" },
              likeCount: 7,
              repostCount: 2,
              replyCount: 1,
              quoteCount: 0,
            },
          ],
        }),
        { status: 200 },
      );
    }
    calls.og++;
    // A page that yields nothing: the state this URL is really in, since
    // bsky.app refuses scrapers.
    return new Response("<html><head></head></html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
  }) as unknown as typeof globalThis.fetch;
  return calls;
}

describe("a link resolving to a Web Tile", () => {
  let ctx: E2eContext;
  let roomId: string;
  let messageId: string;

  beforeEach(async () => {
    ctx = await startAppserver();
    seedSpace(ctx.db, SPACE, OWNER);
    seedJoinedSpace(ctx.db, OWNER, SPACE);
    roomId = newUlid();
    seedRoom(ctx.db, roomId, SPACE, "space.roomy.channel");
    messageId = newUlid();
    seedMessage(ctx.db, messageId, roomId, SPACE);

    // The state a pre-tiles materialisation left behind: a link row with its
    // preview shown, indexed globally, and no store row at all.
    const sp = spaceDb(ctx.db, SPACE);
    sp.run("insert into entities (id, stream_id, room) values (?, '', ?)", [
      POST_URL,
      messageId,
    ]);
    sp.run("insert into comp_embed_link (entity, show_preview) values (?, 1)", [
      POST_URL,
    ]);
    await globalDb(ctx.db).run(
      "insert or ignore into entity_space (entity_id, space_did) values (?, ?)",
      [POST_URL, SPACE],
    );
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("the read queues the tile, the sweep resolves it, and the next read serves it", async () => {
    const calls = stubNetwork();

    // First read: the link is there, its card is not yet.
    const first = await ctx.authedFetch(OWNER)(
      `${ctx.baseUrl}/xrpc/space.roomy.room.getMessages?roomId=${roomId}`,
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      messages: Array<{ linkEmbeds: Array<{ embed?: { tile?: unknown } }> }>;
    };
    expect(firstBody.messages[0]?.linkEmbeds[0]?.embed?.tile).toBeUndefined();

    // The read is what queued the work — nothing scanned the log.
    const pending = await globalDb(ctx.db)
      .query("select count(*) as n from pending_links")
      .get<{ n: number }>();
    expect(pending?.n).toBe(1);

    // One sweep cycle drains it.
    const sweepGlobalDb = openGlobalDb();
    _startSweeperNoLoop({ globalDb: sweepGlobalDb });
    const result = await sweepCycle(sweepGlobalDb);
    await stopEmbedSweeper();
    expect(result.producedOk).toBe(true);
    expect(calls.appview).toBe(1);

    // Second read: the card carries the tile and the projection of the post.
    const second = await ctx.authedFetch(OWNER)(
      `${ctx.baseUrl}/xrpc/space.roomy.room.getMessages?roomId=${roomId}`,
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      messages: Array<{
        linkEmbeds: Array<{
          embed?: { tile?: { url: string; data?: { post: { text: string } } } };
        }>;
      }>;
    };
    const tile = secondBody.messages[0]?.linkEmbeds[0]?.embed?.tile;
    expect(tile?.url).toBe(TILE_MAPPING["app.bsky.feed.post"]);
    expect(tile?.data?.post.text).toBe("the post a tile renders");

    // The pending entry is gone, so the row is not re-resolved by every sweep.
    const after = await globalDb(ctx.db)
      .query("select count(*) as n from pending_links")
      .get<{ n: number }>();
    expect(after?.n).toBe(0);
  });

  test("a dismissed preview is not served a tile", async () => {
    stubNetwork();
    spaceDb(ctx.db, SPACE).run(
      "update comp_embed_link set show_preview = 0 where entity = ?",
      [POST_URL],
    );

    await ctx.authedFetch(OWNER)(
      `${ctx.baseUrl}/xrpc/space.roomy.room.getMessages?roomId=${roomId}`,
    );
    const sweepGlobalDb = openGlobalDb();
    _startSweeperNoLoop({ globalDb: sweepGlobalDb });
    await sweepCycle(sweepGlobalDb);
    await stopEmbedSweeper();

    const res = await ctx.authedFetch(OWNER)(
      `${ctx.baseUrl}/xrpc/space.roomy.room.getMessages?roomId=${roomId}`,
    );
    const body = (await res.json()) as {
      messages: Array<{ linkEmbeds: unknown[]; attachments: unknown[] }>;
    };
    expect(body.messages[0]?.linkEmbeds).toEqual([]);
    expect(body.messages[0]?.attachments).toEqual([]);
  });
});
