/**
 * Invite-link unfurls over HTTP: the page a crawler gets for a join link and
 * the card it names, read anonymously from a seeded space.
 *
 * Run: bun test --cwd packages/appserver src/e2e/ogInvite.test.ts
 */

import { describe, expect, test } from "bun:test";
import { Jimp } from "jimp";
import { createOgRoutes } from "../og/routes.ts";
import { SITE_OG_IMAGE } from "../og/html.ts";
import { globalDb, seedSpace, spaceDb, startAppserver, type E2eContext } from "./helpers.ts";

const OWNER = "did:plc:og-owner";
const SPACE = "did:plc:og-space";

async function seedCard(
  ctx: E2eContext,
  opts: {
    allowPublicJoin?: number;
    handle?: string;
    description?: string;
    avatar?: string;
    members?: number;
  } = {},
) {
  seedSpace(ctx.db, SPACE, OWNER, {
    ...(opts.allowPublicJoin !== undefined ? { allowPublicJoin: opts.allowPublicJoin } : {}),
    ...(opts.handle !== undefined ? { handle: opts.handle } : {}),
  });
  await spaceDb(ctx.db, SPACE).run(
    "update comp_info set name = ?, description = ?, avatar = ? where entity = ?",
    ["Gardeners", opts.description ?? null, opts.avatar ?? null, SPACE],
  );
  if (opts.members !== undefined) {
    await globalDb(ctx.db).run(
      "insert or replace into space_stats (space_did, member_count) values (?, ?)",
      [SPACE, opts.members],
    );
  }
}

describe("GET /og/space/<did>.png", () => {
  test("draws the space's card, anonymously, and revalidates by version", async () => {
    const ctx = await startAppserver();
    await seedCard(ctx, { description: "We grow things.", members: 42, handle: "garden.example" });

    const res = await ctx.anonFetch(`${ctx.baseUrl}/og/space/${encodeURIComponent(SPACE)}.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("public");
    const image = await Jimp.read(Buffer.from(await res.arrayBuffer()));
    expect([image.width, image.height]).toEqual([1200, 630]);

    const etag = res.headers.get("etag")!;
    const again = await ctx.anonFetch(`${ctx.baseUrl}/og/space/${SPACE}.png`, {
      headers: { "if-none-match": etag },
    });
    expect(again.status).toBe(304);
  });

  test("an invite-only space still has a card: its join screen is public too", async () => {
    const ctx = await startAppserver();
    await seedCard(ctx, { allowPublicJoin: 0 });
    const res = await ctx.anonFetch(`${ctx.baseUrl}/og/space/${SPACE}.png`);
    expect(res.status).toBe(200);
  });

  test("HEAD answers without a body", async () => {
    const ctx = await startAppserver();
    await seedCard(ctx);
    const res = await fetch(`${ctx.baseUrl}/og/space/${SPACE}.png`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(Number(res.headers.get("content-length"))).toBeGreaterThan(0);
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  test("an unknown space is sent to the site card, without creating its DB", async () => {
    const ctx = await startAppserver();
    const res = await ctx.anonFetch(`${ctx.baseUrl}/og/space/did:plc:nobody.png`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(SITE_OG_IMAGE);
  });

  test("a path that names no DID is not found", async () => {
    const ctx = await startAppserver();
    const res = await ctx.anonFetch(`${ctx.baseUrl}/og/space/..%2Fetc.png`);
    expect(res.status).toBe(404);
  });
});

describe("GET /og/join", () => {
  test("the query form names the space and links its current card", async () => {
    const ctx = await startAppserver();
    await seedCard(ctx, { description: "We grow things." });

    const res = await ctx.anonFetch(
      `${ctx.baseUrl}/og/join?space=${encodeURIComponent(SPACE)}&invite=tok123`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await res.text();
    expect(html).toContain('<meta property="og:title" content="Join Gardeners on Roomy" />');
    expect(html).toContain('<meta property="og:description" content="We grow things." />');

    const image = html.match(/<meta property="og:image" content="([^"]+)"/)![1]!;
    expect(image).toContain(`/og/space/${encodeURIComponent(SPACE)}.png?v=`);
    // The person who lands here goes back to the join link they were given.
    expect(html).toContain(
      `href="/join?space=${encodeURIComponent(SPACE)}&amp;invite=tok123"`,
    );

    // The card it names is served.
    const path = new URL(image).pathname + new URL(image).search;
    const card = await ctx.anonFetch(`${ctx.baseUrl}${path}`);
    expect(card.status).toBe(200);
  });

  test("the path form resolves a space by its handle", async () => {
    const ctx = await startAppserver();
    await seedCard(ctx, { handle: "garden.example" });
    const html = await (await ctx.anonFetch(`${ctx.baseUrl}/og/join/garden.example`)).text();
    expect(html).toContain("Join Gardeners on Roomy");
  });

  test("the card's version follows the space", async () => {
    const ctx = await startAppserver();
    await seedCard(ctx);
    const imageOf = async () =>
      (await (await ctx.anonFetch(`${ctx.baseUrl}/og/join?space=${SPACE}`)).text()).match(
        /og:image" content="([^"]+)"/,
      )![1];

    const before = await imageOf();
    await spaceDb(ctx.db, SPACE).run("update comp_info set name = ? where entity = ?", [
      "Growers",
      SPACE,
    ]);
    expect(await imageOf()).not.toBe(before);
  });

  test("a link to no known space still unfurls, as the site", async () => {
    const ctx = await startAppserver();
    const res = await ctx.anonFetch(`${ctx.baseUrl}/og/join?space=nowhere.example`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`<meta property="og:image" content="${SITE_OG_IMAGE}" />`);
  });
});

describe("the space's avatar", () => {
  test("is fetched once, drawn in the disc, and the card cached", async () => {
    const ctx = await startAppserver();
    await seedCard(ctx, { avatar: "atblob://did:plc:og-owner/bafkreiavatar" });

    const asked: string[] = [];
    const handleOg = createOgRoutes({
      serviceEndpoint: "https://api.example",
      fetchAvatar: async (ref) => {
        asked.push(ref);
        return new Jimp({ width: 32, height: 32, color: 0x00a0ffff });
      },
    });
    const url = new URL(`https://api.example/og/space/${SPACE}.png`);
    const first = await handleOg(new Request(url), url);
    const second = await handleOg(new Request(url), url);

    expect(asked).toEqual(["atblob://did:plc:og-owner/bafkreiavatar"]);
    expect(second!.status).toBe(200);
    const image = await Jimp.read(Buffer.from(await first!.arrayBuffer()));
    const center = image.getPixelColor(952, 318) >>> 8;
    expect(center.toString(16)).toBe("a0ff");
  });

  test("one that cannot be fetched leaves the initial, not an error", async () => {
    const ctx = await startAppserver();
    await seedCard(ctx, { avatar: "https://unreachable.example/a.png" });
    const handleOg = createOgRoutes({
      serviceEndpoint: "https://api.example",
      fetchAvatar: async () => null,
    });
    const url = new URL(`https://api.example/og/space/${SPACE}.png`);
    const res = await handleOg(new Request(url), url);
    expect(res!.status).toBe(200);
  });
});
