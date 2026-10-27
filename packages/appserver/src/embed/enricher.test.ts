import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { toAsyncDb } from "../db/syncAdapter.ts";
import {
  enrichLinkAcrossSpaces,
  storeEmbedData,
  findPendingLinks,
  filterPendingUrls,
  fetchEmbedData,
  countPendingLinks,
  classifyPendingLinks,
  maxTransientAttempts,
  type PendingLink,
} from "./enricher.ts";
import type { DbLike } from "../db/types.ts";
import type { Embed } from "./types.ts";
import { TILE_MAPPING, TILE_RESOLVER_VERSION, _resetTileCachesForTest } from "./tiles.ts";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMA_PATH = join(__dirname, "..", "db", "schema-space.sql");
const GLOBAL_SCHEMA_PATH = join(__dirname, "..", "db", "schema-global.sql");

function freshDb(): { db: Database; asyncDb: DbLike } {
  const db = new Database(":memory:");
  db.exec("pragma journal_mode = wal");
  db.exec("pragma synchronous = normal");
  db.exec("pragma foreign_keys = on");
  const schemaSql = readFileSync(SCHEMA_PATH, "utf8");
  db.exec(schemaSql);
  return { db, asyncDb: toAsyncDb(db) };
}

/** In-memory global DB (schema-global.sql) for the pending_links index tests. */
function freshGlobalDb(): { db: Database; asyncDb: DbLike } {
  const db = new Database(":memory:");
  db.exec("pragma journal_mode = wal");
  db.exec("pragma synchronous = normal");
  db.exec("pragma foreign_keys = on");
  const schemaSql = readFileSync(GLOBAL_SCHEMA_PATH, "utf8");
  db.exec(schemaSql);
  return { db, asyncDb: toAsyncDb(db) };
}

/** Insert the entity + comp_embed_link rows needed for a URL to be enrichable. */
function seedLink(db: Database, url: string): void {
  db.run("insert into entities (id, stream_id) values (?, ?)", [
    url,
    "did:web:test.example",
  ]);
  db.run("insert into comp_embed_link (entity, show_preview) values (?, 1)", [
    url,
  ]);
}

/** Insert a row into the global pending_links index. */
function seedPendingLink(
  db: Database,
  url: string,
  spaceDid = "did:web:test.example",
  messageId = "msg1",
  createdAt = Date.now(),
): void {
  db.run(
    "insert into pending_links (space_did, message_id, url, created_at) values (?, ?, ?, ?)",
    [spaceDid, messageId, url, createdAt],
  );
}

type DataRow = {
  embed_json: string | null;
  attempts: number;
  retry_after: number | null;
};
/** The store row for `url` — enrichment lives in the global `link_embeds`. */
function dataRow(db: Database, url: string): DataRow | null {
  const row = db
    .query<DataRow, [string]>(
      "select embed_json, attempts, retry_after from link_embeds where url = ?",
    )
    .get(url);
  return row ?? null;
}

const EMBED: Embed = { v: "1", ts: "x", ty: "link", t: "T" };

describe("embed retry-with-backoff (storeEmbedData)", () => {
  test("transient failure schedules a retry with escalating backoff", async () => {
    const { db, asyncDb } = freshGlobalDb();
    const url = "https://a.example";

    // First transient failure: attempts=1, retry_after ~1m in the future.
    await storeEmbedData(asyncDb, url, { status: "transient" });
    let row = dataRow(db, url)!;
    expect(row.attempts).toBe(1);
    expect(row.retry_after).not.toBeNull();
    expect((row.retry_after ?? 0) > Date.now()).toBe(true); // in the future
    const firstRetry = row.retry_after!;

    // Second transient failure: attempts=2, backoff escalates (later retry).
    await storeEmbedData(asyncDb, url, { status: "transient" });
    row = dataRow(db, url)!;
    expect(row.attempts).toBe(2);
    expect((row.retry_after ?? 0) > firstRetry).toBe(true);
  });

  test("a URL that keeps failing transiently is settled at the attempt ceiling", async () => {
    const { db, asyncDb } = freshGlobalDb();
    const url = "https://dead.example";
    const ceiling = maxTransientAttempts();

    // Every attempt before the ceiling schedules a retry and leaves the row
    // pending: a host that is merely slow must survive a transient outage.
    for (let i = 1; i < ceiling; i++) {
      expect(await storeEmbedData(asyncDb, url, { status: "transient" })).toBe(false);
      const row = dataRow(db, url)!;
      expect(row.attempts).toBe(i);
      expect(row.retry_after).not.toBeNull();
    }

    // The ceiling attempt settles the row exactly like a definitive failure,
    // so the sweeper drops it instead of re-fetching a host that is gone.
    expect(await storeEmbedData(asyncDb, url, { status: "transient" })).toBe(true);
    const settled = dataRow(db, url)!;
    expect(settled.attempts).toBe(ceiling);
    expect(settled.embed_json).toBeNull();
    expect(settled.retry_after).toBeNull();
  });

  test("definitive failure (404 / no-data) settles with no retry", async () => {
    const { db, asyncDb } = freshGlobalDb();
    const url = "https://c.example";
    await storeEmbedData(asyncDb, url, { status: "definitive" });
    const row = dataRow(db, url)!;
    expect(row.embed_json).toBeNull();
    expect(row.attempts).toBe(0);
    expect(row.retry_after).toBeNull();
  });

  test("success stores embed data and clears any prior retry state", async () => {
    const { db, asyncDb } = freshGlobalDb();
    const url = "https://d.example";
    // Fail transiently first (sets attempts + retry_after), then succeed.
    await storeEmbedData(asyncDb, url, { status: "transient" });
    await storeEmbedData(asyncDb, url, { status: "ok", embed: EMBED });
    const row = dataRow(db, url)!;
    expect(row.embed_json).not.toBeNull();
    expect(row.attempts).toBe(0);
    expect(row.retry_after).toBeNull();
  });

  test("a URL enriched once is stored once, however many spaces hold it", async () => {
    // The store is keyed by URL, so a URL shared in three spaces is one row —
    // the per-space copy this replaced wrote one per space and made the read
    // paths unable to serve a space derived by another worker.
    const { db, asyncDb } = freshGlobalDb();
    const url = "https://shared.example";
    await storeEmbedData(asyncDb, url, { status: "ok", embed: EMBED });

    const rows = db
      .query<{ n: number }, []>("select count(*) as n from link_embeds")
      .get();
    expect(rows!.n).toBe(1);
    expect(dataRow(db, url)!.embed_json).toContain('"T"');
  });

  test("filterPendingUrls (priority) only returns never-attempted links", async () => {
    const { db: spaceDb, asyncDb } = freshDb();
    const { db: globalDb, asyncDb: globalAsyncDb } = freshGlobalDb();
    seedLink(spaceDb, "https://new.example");
    seedLink(spaceDb, "https://failed.example");
    await storeEmbedData(globalAsyncDb, "https://failed.example", {
      status: "transient",
    });
    const got = await filterPendingUrls(asyncDb, globalAsyncDb, [
      "https://new.example",
      "https://failed.example",
    ]);
    // Priority is for freshly-detected (never-attempted) links only — a
    // transiently-failed URL already has a store row (with a future
    // retry_after) and must wait for its backoff via the backlog, not jump the
    // queue again.
    expect(got).toContain("https://new.example");
    expect(got).not.toContain("https://failed.example");
  });

  test("filterPendingUrls only returns URLs the space actually holds", async () => {
    // The per-space side is what narrows the candidates: the store is global,
    // so a URL enriched by another space must not be prioritised here unless
    // one of this space's messages contains it.
    const { db: spaceDb, asyncDb } = freshDb();
    const { asyncDb: globalAsyncDb } = freshGlobalDb();
    seedLink(spaceDb, "https://held.example");

    const got = await filterPendingUrls(asyncDb, globalAsyncDb, [
      "https://held.example",
      "https://not-held.example",
    ]);
    expect(got).toEqual(["https://held.example"]);
  });

  test("filterPendingUrls hands back a link attachment's canonical URL, not its entity id", async () => {
    // A `link.v0` attachment's entity id carries the message encoding, but the
    // sweeper stores under the bare URL — the key every read looks up. Poking
    // it with the entity id would fetch and store a row nothing resolves.
    const { db: spaceDb, asyncDb } = freshDb();
    const { asyncDb: globalAsyncDb } = freshGlobalDb();
    const url = "https://attached.example/1";
    seedLink(spaceDb, `${url}?message=01MSGA00000000000000000000`);

    const got = await filterPendingUrls(asyncDb, globalAsyncDb, [
      `${url}?message=01MSGA00000000000000000000`,
    ]);

    expect(got).toEqual([url]);
  });

  test("filterPendingUrls treats an attachment link as enriched once its canonical URL is stored", async () => {
    const { db: spaceDb, asyncDb } = freshDb();
    const { asyncDb: globalAsyncDb } = freshGlobalDb();
    const url = "https://attached.example/2";
    seedLink(spaceDb, `${url}?message=01MSGB00000000000000000000`);
    await storeEmbedData(globalAsyncDb, url, { status: "ok", embed: EMBED });

    const got = await filterPendingUrls(asyncDb, globalAsyncDb, [
      `${url}?message=01MSGB00000000000000000000`,
    ]);

    // The store row is under the canonical key, so the read-driven
    // prioritisation must not re-poke it under the entity id.
    expect(got).toEqual([]);
  });
});

describe("global pending_links index (findPendingLinks / countPendingLinks)", () => {
  test("findPendingLinks returns pending rows oldest-first with space + message", async () => {
    const { db, asyncDb } = freshGlobalDb();
    seedPendingLink(db, "https://old.example", "did:web:a", "m1", 1000);
    seedPendingLink(db, "https://new.example", "did:web:b", "m2", 2000);

    const pending = await findPendingLinks(asyncDb);
    expect(pending.map((p) => p.url)).toEqual([
      "https://old.example",
      "https://new.example",
    ]);
    expect(pending[0]).toMatchObject({
      url: "https://old.example",
      spaceDid: "did:web:a",
      messageId: "m1",
    });
    expect(pending[1]).toMatchObject({
      url: "https://new.example",
      spaceDid: "did:web:b",
      messageId: "m2",
    });
  });

  test("findPendingLinks respects the limit", async () => {
    const { db, asyncDb } = freshGlobalDb();
    seedPendingLink(db, "https://one.example", "did:web:a", "m1", 1000);
    seedPendingLink(db, "https://two.example", "did:web:a", "m2", 2000);
    seedPendingLink(db, "https://three.example", "did:web:a", "m3", 3000);

    const pending = await findPendingLinks(asyncDb, 2);
    expect(pending.map((p) => p.url)).toEqual([
      "https://one.example",
      "https://two.example",
    ]);
  });

  test("countPendingLinks counts all pending rows", async () => {
    const { db, asyncDb } = freshGlobalDb();
    expect(await countPendingLinks(asyncDb)).toBe(0);
    seedPendingLink(db, "https://one.example", "did:web:a", "m1");
    seedPendingLink(db, "https://two.example", "did:web:b", "m2");
    expect(await countPendingLinks(asyncDb)).toBe(2);
    expect(await countPendingLinks(asyncDb)).toBe((await findPendingLinks(asyncDb)).length);
  });

  test("classifyPendingLinks counts ROWS, not distinct URLs", async () => {
    // The PK is (space_did, message_id, url): one URL pending in two messages
    // is TWO rows. This is the unit mismatch that made `pending - transientBackoff`
    // look like selectable work.
    const { db, asyncDb } = freshGlobalDb();
    seedPendingLink(db, "https://dup.example", "did:web:a", "m1");
    seedPendingLink(db, "https://dup.example", "did:web:a", "m2");
    seedPendingLink(db, "https://other.example", "did:web:a", "m3");

    const all = await classifyPendingLinks(asyncDb, new Set());
    expect(all).toEqual({ total: 3, selectable: 3, parked: 0 });

    // Park one URL: BOTH of its rows become parked, so only 1 row remains
    // selectable even though 2 URLs exist. A URL-keyed `parked` count cannot
    // express this.
    const parkedUrl = await classifyPendingLinks(
      asyncDb,
      new Set(["https://dup.example"]),
    );
    expect(parkedUrl).toEqual({ total: 3, selectable: 1, parked: 2 });
  });

  test("classifyPendingLinks reports zero selectable when every row is parked", async () => {
    // A URL-keyed count over-reports here: many rows can share few parked
    // URLs, so `total - parkedUrls` looks selectable while every ROW is
    // parked. The row-level count must say 0.
    const { db, asyncDb } = freshGlobalDb();
    seedPendingLink(db, "https://a.example", "did:web:a", "m1");
    seedPendingLink(db, "https://a.example", "did:web:a", "m2");
    seedPendingLink(db, "https://b.example", "did:web:a", "m3");

    const out = await classifyPendingLinks(
      asyncDb,
      new Set(["https://a.example", "https://b.example"]),
    );
    expect(out.selectable).toBe(0);
    expect(out.parked).toBe(out.total);

    // Agrees with the selection query: nothing is selectable, so it returns [].
    const selected = await findPendingLinks(
      asyncDb,
      25,
      new Set(["https://a.example", "https://b.example"]),
    );
    expect(selected).toEqual([]);
  });
});

describe("fetchEmbedData status classification", () => {
  // Enrichment now runs through the in-appserver OG/oEmbed pipeline, which
  // fetches the target URL directly. Stub global.fetch so no real network
  // call is made.
  const realFetch = globalThis.fetch;

  function stub(status: number, body = "", reject = false): void {
    globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) =>
      reject
        ? Promise.reject(new TypeError("fetch failed"))
        : Promise.resolve(new Response(body, { status }))
    ) as typeof globalThis.fetch;
  }

  function withStub<T>(fn: () => Promise<T>): Promise<T> {
    return fn().finally(() => {
      globalThis.fetch = realFetch;
    });
  }

  test("stable 4xx are definitive (no retry) — bot-blocked/gone settle", async () => {
    for (const status of [400, 401, 403, 404, 410]) {
      stub(status, "blocked");
      const result = await withStub(() => fetchEmbedData("https://x.example"));
      expect(result).toEqual({ status: "definitive" });
    }
  });

  test("429 and 5xx are transient (retry later)", async () => {
    for (const status of [429, 500, 502, 503]) {
      stub(status);
      const result = await withStub(() => fetchEmbedData("https://x.example"));
      expect(result).toEqual({ status: "transient" });
    }
  });

  test("network error is transient (retry later)", async () => {
    stub(0, "", true);
    const result = await withStub(() => fetchEmbedData("https://x.example"));
    expect(result).toEqual({ status: "transient" });
  });

  test("200 with OpenGraph HTML is ok", async () => {
    const html =
      '<meta property="og:title" content="Roomy" />' +
      '<meta property="og:description" content="Built on ATProto" />';
    stub(200, `<html><head>${html}</head></html>`);
    const result = await withStub(() => fetchEmbedData("https://x.example"));
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.embed.t).toBe("Roomy");
      expect(result.embed.d).toBe("Built on ATProto");
      expect(result.embed.ty).toBe("link");
    }
  });

  test("200 with no metadata HTML is definitive", async () => {
    stub(200, "<html><head></head></html>");
    const result = await withStub(() => fetchEmbedData("https://x.example"));
    expect(result).toEqual({ status: "definitive" });
  });

  test("non-http URL is definitive (no network)", async () => {
    const result = await fetchEmbedData("not-a-url");
    expect(result).toEqual({ status: "definitive" });
  });
});

describe("embed attempt ceiling", () => {
  test("a URL that keeps failing transiently is settled at the ceiling", async () => {
    const { db, asyncDb } = freshGlobalDb();
    const url = "https://dead.example";
    const ceiling = maxTransientAttempts();

    // Every attempt before the ceiling schedules a retry and leaves the row
    // pending: a host that is merely slow must survive a transient outage.
    for (let i = 1; i < ceiling; i++) {
      expect(await storeEmbedData(asyncDb, url, { status: "transient" })).toBe(false);
      const row = dataRow(db, url)!;
      expect(row.attempts).toBe(i);
      expect(row.retry_after).not.toBeNull();
    }

    // The ceiling attempt settles the row exactly like a definitive failure,
    // so the sweeper drops it instead of re-fetching a host that is gone.
    expect(await storeEmbedData(asyncDb, url, { status: "transient" })).toBe(true);
    const settled = dataRow(db, url)!;
    expect(settled.attempts).toBe(ceiling);
    expect(settled.embed_json).toBeNull();
    expect(settled.retry_after).toBeNull();
  });

  test("a URL persisted without a ceiling is settled on its next transient failure", async () => {
    // Attempts recorded by a build that had no ceiling exceed the new one.
    // The row must settle rather than be retried forever, or the inherited
    // dead set keeps re-entering the backlog under the new code.
    const { db, asyncDb } = freshGlobalDb();
    const url = "https://inherited.example";
    db.run(
      `insert into link_embeds (url, embed_json, attempts, retry_after)
       values (?, null, 40, ?)`,
      [url, Date.now() + 60 * 60_000],
    );

    expect(await storeEmbedData(asyncDb, url, { status: "transient" })).toBe(true);
    const row = dataRow(db, url)!;
    expect(row.attempts).toBeGreaterThanOrEqual(maxTransientAttempts());
    expect(row.retry_after).toBeNull();
  });
});

// ─── The tile half of a row ─────────────────────────────────────────────

const POST_DID = "did:plc:z72i7hdynmk6r22z27h6tvur";
const POST_URL = `https://bsky.app/profile/${POST_DID}/post/3kabc`;

/** A `getPosts` body for {@link POST_URL}. */
function appViewBody(text = "a post"): string {
  return JSON.stringify({
    posts: [
      {
        uri: `at://${POST_DID}/app.bsky.feed.post/3kabc`,
        author: { did: POST_DID, handle: "bsky.app", displayName: "Bluesky" },
        record: { text, createdAt: "2026-10-20T10:00:00.000Z" },
        likeCount: 1,
        repostCount: 0,
        replyCount: 0,
        quoteCount: 0,
      },
    ],
  });
}

/**
 * Route outbound fetches by host: the AppView answer is what the tile half
 * reads, and `ogCalls` counts any attempt to re-read the page itself.
 */
function stubFetch(appView: () => Response, ogHtml = "<html></html>") {
  const calls = { og: 0, appview: 0 };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("app.bsky.feed.getPosts")) {
      calls.appview++;
      return appView();
    }
    calls.og++;
    return new Response(ogHtml, { status: 200, headers: { "Content-Type": "text/html" } });
  }) as unknown as typeof globalThis.fetch;
  return calls;
}

describe("tile resolution in the embed store", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    _resetTileCachesForTest();
  });

  test("filterPendingUrls picks up an enriched URL whose tile was never resolved", async () => {
    // The retroactive case: an OpenGraph row settled before tiles existed is
    // not "done" any more, because its tile has never been attempted.
    const { db: spaceDb, asyncDb } = freshDb();
    const { asyncDb: globalAsyncDb } = freshGlobalDb();
    seedLink(spaceDb, POST_URL);
    await storeEmbedData(globalAsyncDb, POST_URL, { status: "ok", embed: EMBED });

    expect(await filterPendingUrls(asyncDb, globalAsyncDb, [POST_URL])).toEqual([POST_URL]);
  });

  test("filterPendingUrls drops a tile URL once its tile is current", async () => {
    const { db: spaceDb, asyncDb } = freshDb();
    const { asyncDb: globalAsyncDb } = freshGlobalDb();
    seedLink(spaceDb, POST_URL);
    await storeEmbedData(globalAsyncDb, POST_URL, { status: "ok", embed: EMBED }, {
      tileVersion: TILE_RESOLVER_VERSION,
    });

    expect(await filterPendingUrls(asyncDb, globalAsyncDb, [POST_URL])).toEqual([]);
  });

  test("a stale tile is resolved without re-fetching the page", async () => {
    const { db, asyncDb } = freshGlobalDb();
    await storeEmbedData(
      asyncDb,
      POST_URL,
      { status: "ok", embed: { v: "1", ts: "x", ty: "link", t: "Stored title" } },
      { tileVersion: 0 },
    );
    const calls = stubFetch(() => new Response(appViewBody(), { status: 200 }));

    const outcome = await enrichLinkAcrossSpaces(asyncDb, POST_URL);

    expect(outcome.status).toBe("ok");
    expect(calls.og).toBe(0);
    expect(calls.appview).toBe(1);
    const stored = JSON.parse(dataRow(db, POST_URL)!.embed_json!) as Embed;
    // The OpenGraph half is untouched; the tile half is new.
    expect(stored.t).toBe("Stored title");
    expect(stored.tile?.url).toBe(TILE_MAPPING["app.bsky.feed.post"]);
    expect((stored.tile?.data as { post: { text: string } }).post.text).toBe("a post");
    expect(
      db
        .query<{ tile_version: number | null }, [string]>(
          "select tile_version from link_embeds where url = ?",
        )
        .get(POST_URL)!.tile_version,
    ).toBe(TILE_RESOLVER_VERSION);
  });

  test("a post the AppView does not have is settled, not retried", async () => {
    const { db, asyncDb } = freshGlobalDb();
    await storeEmbedData(asyncDb, POST_URL, { status: "ok", embed: EMBED });
    stubFetch(() => new Response(JSON.stringify({ posts: [] }), { status: 200 }));

    // The row still renders the OpenGraph card it already had, so the outcome
    // is `ok` — what matters is that it SETTLED rather than parked for a retry
    // that cannot bring a deleted record back.
    expect((await enrichLinkAcrossSpaces(asyncDb, POST_URL)).status).toBe("ok");
    expect(dataRow(db, POST_URL)!.retry_after).toBeNull();
    expect(
      db
        .query<{ tile_version: number | null }, [string]>(
          "select tile_version from link_embeds where url = ?",
        )
        .get(POST_URL)!.tile_version,
    ).toBe(TILE_RESOLVER_VERSION);
  });

  test("a tile that cannot resolve now leaves the row pending and keeps the OpenGraph card", async () => {
    const { db, asyncDb } = freshGlobalDb();
    await storeEmbedData(asyncDb, POST_URL, {
      status: "ok",
      embed: { v: "1", ts: "x", ty: "link", t: "Stored title" },
    });
    stubFetch(() => new Response("later", { status: 503 }));

    expect((await enrichLinkAcrossSpaces(asyncDb, POST_URL)).status).toBe("transient");
    const row = dataRow(db, POST_URL)!;
    expect(row.retry_after).not.toBeNull();
    expect(JSON.parse(row.embed_json!)).toMatchObject({ t: "Stored title" });
  });

  test("one half resolving while the other retries is reported as partial", async () => {
    // The page 503s while the AppView answers: the tile is stored and
    // announced, and the row stays pending for the OpenGraph retry.
    const { db, asyncDb } = freshGlobalDb();
    stubFetch(
      () => new Response(appViewBody(), { status: 200 }),
      "<html></html>",
    );
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("app.bsky.feed.getPosts")) {
        return new Response(appViewBody(), { status: 200 });
      }
      return new Response("later", { status: 503 });
    }) as unknown as typeof globalThis.fetch;

    const outcome = await enrichLinkAcrossSpaces(asyncDb, POST_URL);
    expect(outcome.status).toBe("partial");
    const row = dataRow(db, POST_URL)!;
    expect(row.retry_after).not.toBeNull();
    expect(JSON.parse(row.embed_json!)).toHaveProperty("tile");
  });

  test("a URL no tile mapping claims is untouched by the tile half", async () => {
    const { asyncDb } = freshGlobalDb();
    const calls = stubFetch(() => new Response(appViewBody(), { status: 200 }));
    await enrichLinkAcrossSpaces(asyncDb, "https://example.com/plain");
    expect(calls.appview).toBe(0);
    expect(calls.og).toBe(1);
  });
});
