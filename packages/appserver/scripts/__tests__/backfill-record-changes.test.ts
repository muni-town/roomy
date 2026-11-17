/**
 * The feed audit: does `--verify` report a short `record_changes`?
 *
 * A gap in the feed is silent otherwise — the consumer applies fewer changes
 * and SQLite reports only the foreign-key failure a missing parent entity
 * causes. The audit exists to name the entry, so these tests are about what it
 * counts as a gap and what it deliberately does not: an entry the feed is right
 * to omit, an entry whose adapter throws, and an entry whose row set is only
 * part of what the adapter emits.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { encode } from "@atcute/cbor";
import { ulid } from "ulidx";
import type { StreamDid } from "@roomy-space/sdk";

import { toAsyncDb } from "../../src/db/syncAdapter.ts";
import {
  CORPUS_STREAM,
  buildCorpus,
  logged,
  sample,
  type Fixture,
} from "../../src/materialization/records/corpus.ts";
import type { LoggedEvent } from "../../src/materialization/types.ts";
import { feedRows, writeRecordChanges } from "../../src/streams/recordChanges.ts";
import {
  formatAudit,
  parseArgs,
  verifyFeed,
  type AuditReport,
} from "../backfill-record-changes.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVENTS_SCHEMA_PATH = join(
  __dirname,
  "..",
  "..",
  "src",
  "db",
  "eventsSchema.sql",
);

const STREAM = CORPUS_STREAM;

// One log, every entry of which the adapter converts, so the feed is complete
// unless a test removes something from it.
const { entries, fx } = buildCorpus({ recordProducingOnly: true });

let root: string;
let eventsPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "backfill-record-changes-"));
  eventsPath = join(root, "roomy-events.sqlite");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * A corpus event in the shape the log stores: CBOR carries bytes as a `$bytes`
 * wrapper, while the adapter's own fixture carries the decoded `{ buf }` form.
 */
function encodable(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { $bytes: Buffer.from(value).toString("base64") };
  }
  if (Array.isArray(value)) return value.map(encodable);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.buf instanceof Uint8Array) {
      return { $bytes: Buffer.from(record.buf).toString("base64") };
    }
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(record)) {
      out[key] = encodable(inner);
    }
    return out;
  }
  return value;
}

/** An events DB holding `log`, with the feed written for it unless skipped. */
async function buildEvents(
  log: LoggedEvent[],
  opts: { feed?: boolean } = {},
): Promise<void> {
  const db = new Database(eventsPath);
  db.exec(readFileSync(EVENTS_SCHEMA_PATH, "utf8"));
  const insert = db.prepare(
    `insert into stream_events (stream_id, idx, user, payload, received_at, created_at)
     values (?, ?, ?, ?, ?, ?)`,
  );
  for (const entry of log) {
    insert.run(
      STREAM,
      entry.idx,
      entry.user,
      encode(encodable(entry.event) as Parameters<typeof encode>[0]),
      entry.receivedAt ?? null,
      entry.createdAt ?? null,
    );
  }
  if (opts.feed !== false) {
    await writeRecordChanges(toAsyncDb(db), STREAM, log);
  }
  db.close();
}

/** Run a write against the events DB, the way a partial write would leave it. */
function mutate(sql: string, params: (string | number)[]): void {
  const db = new Database(eventsPath);
  db.run(sql, params);
  db.close();
}

async function verify(): Promise<{ report: AuditReport; exitCode: 0 | 1 | 2 }> {
  return verifyFeed({ eventsPath });
}

/** A fresh event of `$type`, minted against the corpus fixture's ids. */
function eventOf(
  $type: Parameters<typeof sample>[0],
  overrides: Record<string, unknown> = {},
) {
  return sample($type, fx as Fixture, () => ulid(), overrides);
}

describe("a complete feed", () => {
  test("reports no gap and exits 0", async () => {
    await buildEvents(entries);

    const { report, exitCode } = await verify();

    expect(exitCode).toBe(0);
    expect(report.gaps).toEqual([]);
    expect(report.error).toBeUndefined();
    expect(report.streams).toHaveLength(1);
    expect(report.streams[0]!.events).toBe(entries.length);
    expect(report.streams[0]!.gaps).toBe(0);
    expect(formatAudit(report)).toContain("— complete");
  }, 30_000);
});

describe("an entry with no row", () => {
  test("is reported by idx, event id and type, and nothing else is", async () => {
    await buildEvents(entries);
    const target = entries.find(
      (entry) => entry.event.$type === "space.roomy.message.createMessage.v0",
    )!;
    mutate("delete from record_changes where stream_id = ? and idx = ?", [
      STREAM,
      target.idx,
    ]);

    const { report, exitCode } = await verify();

    expect(exitCode).toBe(1);
    expect(report.gaps).toHaveLength(1);
    expect(report.gaps[0]).toEqual({
      stream: STREAM,
      idx: target.idx,
      eventId: target.event.id,
      type: target.event.$type,
      reason: "rows-missing",
    });
    expect(report.streams[0]!.gaps).toBe(1);
    expect(formatAudit(report)).toContain("— incomplete");
  }, 30_000);
});

describe("an entry only partly in the feed", () => {
  test("is reported as rows-partial", async () => {
    await buildEvents(entries);
    const target = entries.find(
      (entry) => feedRows(entry, STREAM as StreamDid).length > 1,
    )!;
    mutate(
      "delete from record_changes where stream_id = ? and idx = ? and ord = 1",
      [STREAM, target.idx],
    );

    const { report, exitCode } = await verify();

    expect(exitCode).toBe(1);
    expect(report.gaps).toEqual([
      {
        stream: STREAM,
        idx: target.idx,
        eventId: target.event.id,
        type: target.event.$type,
        reason: "rows-partial",
      },
    ]);
  }, 30_000);
});

describe("an entry the adapter cannot describe", () => {
  test("is reported with the adapter-threw reason", async () => {
    // A record key the rkey validator rejects, which is how the adapter fails
    // on a malformed log row.
    const broken = logged(eventOf("space.roomy.message.createMessage.v0", { id: ".." }), 0);
    await buildEvents([broken]);

    const { report, exitCode } = await verify();

    expect(exitCode).toBe(1);
    expect(report.gaps).toEqual([
      {
        stream: STREAM,
        idx: 0,
        eventId: broken.event.id,
        type: "space.roomy.message.createMessage.v0",
        reason: "adapter-threw",
      },
    ]);
  }, 30_000);
});

describe("an event type that declares no record", () => {
  test("is not a gap", async () => {
    const handle = logged(eventOf("space.roomy.space.setHandleProvider.v0"), 0);
    await buildEvents([handle]);

    const { report, exitCode } = await verify();

    expect(exitCode).toBe(0);
    expect(report.gaps).toEqual([]);
    expect(report.streams[0]!.events).toBe(1);
  }, 30_000);
});

describe("the command line", () => {
  test("exits 1 and names the gap when the feed is short", async () => {
    await buildEvents(entries);
    const target = entries.find(
      (entry) => entry.event.$type === "space.roomy.message.createMessage.v0",
    )!;
    mutate("delete from record_changes where stream_id = ? and idx = ?", [
      STREAM,
      target.idx,
    ]);

    const proc = Bun.spawnSync(
      [
        process.execPath,
        "run",
        join(__dirname, "..", "backfill-record-changes.ts"),
        "--verify",
        "--events",
        eventsPath,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );

    expect(proc.exitCode).toBe(1);
    const stdout = proc.stdout.toString();
    expect(stdout).toContain("1 gap — incomplete");
    expect(stdout).toContain(`idx ${target.idx}  ${target.event.id}`);
  }, 60_000);
});

describe("--json", () => {
  test("prints a document that parses, with the summary and no gap entries", async () => {
    await buildEvents(entries);

    const proc = Bun.spawnSync(
      [
        process.execPath,
        "run",
        join(__dirname, "..", "backfill-record-changes.ts"),
        "--verify",
        "--json",
        "--events",
        eventsPath,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );

    expect(proc.exitCode).toBe(0);
    const document: AuditReport = JSON.parse(proc.stdout.toString());
    expect(document.gaps).toEqual([]);
    expect(document.streams).toEqual([
      { stream: STREAM, events: entries.length, gaps: 0 },
    ]);
  }, 60_000);
});

describe("the check cannot run", () => {
  test("exits 2 when the database is not an events database", async () => {
    const db = new Database(eventsPath);
    db.exec("create table unrelated (id integer)");
    db.close();

    const { report, exitCode } = await verify();

    expect(exitCode).toBe(2);
    expect(report.error).toContain("no stream_events table");
  }, 30_000);

  test("exits 2 when the file does not exist", async () => {
    const { report, exitCode } = await verifyFeed({
      eventsPath: join(root, "absent.sqlite"),
    });

    expect(exitCode).toBe(2);
    expect(report.error).toBeDefined();
  }, 30_000);
});

describe("arguments", () => {
  test("--json needs --verify", () => {
    expect(parseArgs(["--json"]).ok).toBe(false);
  });

  test("--dry-run and --verify are exclusive", () => {
    expect(parseArgs(["--verify", "--dry-run"]).ok).toBe(false);
  });

  test("--stream narrows the run", async () => {
    await buildEvents(entries);

    const { report, exitCode } = await verifyFeed({
      eventsPath,
      stream: "did:web:nobody.example",
    });

    expect(exitCode).toBe(0);
    expect(report.streams.map((s) => s.stream)).toEqual([
      "did:web:nobody.example",
    ]);
  }, 30_000);
});
