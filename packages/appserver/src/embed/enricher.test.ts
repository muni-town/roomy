import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { openDb } from "../db/db.ts";
import {
  storeEmbedData,
  findPendingLinks,
  filterPendingUrls,
} from "./enricher.ts";
import type { Embed } from "./types.ts";

function freshDb(): Database {
  return openDb({ path: ":memory:", isolated: true });
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

type DataRow = {
  embed_json: string | null;
  attempts: number;
  retry_after: number | null;
};

function dataRow(db: Database, url: string): DataRow | null {
  return db
    .query<DataRow, [string]>(
      "select embed_json, attempts, retry_after from comp_embed_link_data where entity = ?",
    )
    .get(url);
}

const EMBED: Embed = { v: "1", ts: "x", ty: "link", t: "T" };

describe("embed retry-with-backoff", () => {
  test("transient failure schedules a retry with escalating backoff", () => {
    const db = freshDb();
    seedLink(db, "https://a.example");

    // First transient failure: attempts=1, retry_after ~1m in the future.
    storeEmbedData(db, "https://a.example", { status: "transient" });
    let row = dataRow(db, "https://a.example")!;
    expect(row.attempts).toBe(1);
    expect(row.retry_after).not.toBeNull();
    expect((row.retry_after ?? 0) > Date.now()).toBe(true); // in the future
    const firstRetry = row.retry_after!;

    // Second transient failure: attempts=2, backoff escalates (later retry).
    storeEmbedData(db, "https://a.example", { status: "transient" });
    row = dataRow(db, "https://a.example")!;
    expect(row.attempts).toBe(2);
    expect((row.retry_after ?? 0) > firstRetry).toBe(true);

    // Backoff not yet elapsed → the URL is NOT in the pending set.
    expect(findPendingLinks(db)).not.toContain("https://a.example");
  });

  test("definitive failure (404 / no-data) settles with no retry", () => {
    const db = freshDb();
    seedLink(db, "https://c.example");
    storeEmbedData(db, "https://c.example", { status: "definitive" });
    const row = dataRow(db, "https://c.example")!;
    expect(row.embed_json).toBeNull();
    expect(row.attempts).toBe(0);
    expect(row.retry_after).toBeNull();
    // Settled — not pending, will never be retried.
    expect(findPendingLinks(db)).not.toContain("https://c.example");
  });

  test("success stores embed data and clears any prior retry state", () => {
    const db = freshDb();
    seedLink(db, "https://d.example");
    // Fail transiently first (sets attempts + retry_after), then succeed.
    storeEmbedData(db, "https://d.example", { status: "transient" });
    storeEmbedData(db, "https://d.example", { status: "ok", embed: EMBED });
    const row = dataRow(db, "https://d.example")!;
    expect(row.embed_json).not.toBeNull();
    expect(row.attempts).toBe(0);
    expect(row.retry_after).toBeNull();
    expect(findPendingLinks(db)).not.toContain("https://d.example");
  });

  test("findPendingLinks returns never-attempted and retry-eligible rows only", () => {
    const db = freshDb();
    seedLink(db, "https://never.example"); // no data row → pending
    seedLink(db, "https://retry.example");
    seedLink(db, "https://settled.example");
    storeEmbedData(db, "https://retry.example", { status: "transient" }); // future retry_after
    storeEmbedData(db, "https://settled.example", { status: "definitive" });

    // Only the never-attempted link is pending (retry's backoff hasn't elapsed).
    let pending = findPendingLinks(db);
    expect(pending).toContain("https://never.example");
    expect(pending).not.toContain("https://retry.example");
    expect(pending).not.toContain("https://settled.example");

    // Fast-forward: force the retry row's retry_after into the past.
    db.run(
      "update comp_embed_link_data set retry_after = ? where entity = ?",
      [Date.now() - 1000, "https://retry.example"],
    );
    pending = findPendingLinks(db);
    expect(pending).toContain("https://retry.example"); // now eligible for retry
  });

  test("filterPendingUrls (priority) only returns never-attempted links", () => {
    const db = freshDb();
    seedLink(db, "https://new.example");
    seedLink(db, "https://failed.example");
    storeEmbedData(db, "https://failed.example", { status: "transient" });
    const got = filterPendingUrls(db, [
      "https://new.example",
      "https://failed.example",
    ]);
    // Priority is for freshly-detected (never-attempted) links only — a
    // transiently-failed URL already has a data row (with a future retry_after)
    // and must wait for its backoff via the backlog, not jump the queue again.
    expect(got).toContain("https://new.example");
    expect(got).not.toContain("https://failed.example");
  });
});