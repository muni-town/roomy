/**
 * Unit tests for `WorkerLink`'s slow-request bookkeeping.
 *
 * A slow request is logged with the DB it actually targeted. The route is
 * merged into the posted message (`{ ...req, ...route }`) and never written
 * back onto the request body, so the log record has to read the route the link
 * kept alongside the request; reading the body alone labels every routed
 * request as the default `events` target.
 *
 * The worker is a fixture (`asyncDatabaseWorker.fixture.ts`) that reports every
 * reply as slow and echoes the request it received.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { join } from "node:path";
import { _setLokiSink } from "../log.ts";
import type { LokiSink } from "../telemetry/loki.ts";
import { WorkerLink } from "./asyncDatabase.ts";
import type { DbRoute } from "./asyncDatabase.ts";
import type { WorkerRequest } from "./types.ts";

const WORKER_PATH = join(import.meta.dir, "asyncDatabaseWorker.fixture.ts");

interface CapturedRecord {
  line: string;
  labels: Record<string, string>;
  ts: number;
}

let captured: CapturedRecord[] = [];
let links: WorkerLink[] = [];
let origLogLevel: string | undefined;
let origAlloyUrl: string | undefined;

function captureSink(): LokiSink {
  return {
    push: (record) => {
      captured.push(record);
    },
    flush: async () => {},
    stop: () => {},
    stats: () => ({ queued: 0, sent: 0, dropped: 0, failed: 0 }),
  };
}

/** The most recent `[db-slow]` record, parsed from the emitted JSON line. */
function lastSlowLog(): Record<string, unknown> {
  const records = captured
    .map((r) => JSON.parse(r.line) as Record<string, unknown>)
    .filter((record) => record.scope === "db-slow");
  const last = records.at(-1);
  if (!last) throw new Error("no [db-slow] log record captured");
  return last;
}

/** The fixture echoes the request it received; check that shape once. */
function asWorkerRequest(value: unknown): WorkerRequest {
  if (
    value === null ||
    typeof value !== "object" ||
    !("type" in value) ||
    typeof value.type !== "string" ||
    !("id" in value) ||
    typeof value.id !== "string"
  ) {
    throw new Error("fixture worker did not echo a worker request");
  }
  return value as WorkerRequest;
}

/** Drive one request through a link and return the request the worker got. */
async function sendThrough(
  link: WorkerLink,
  req: Omit<WorkerRequest, "id">,
  route?: DbRoute,
): Promise<WorkerRequest> {
  const result = await link.send(req, route);
  if (result === null || typeof result !== "object" || !("received" in result)) {
    throw new Error("fixture worker reply carried no request");
  }
  return asWorkerRequest(result.received);
}

beforeEach(() => {
  captured = [];
  links = [];
  origLogLevel = process.env.LOG_LEVEL;
  origAlloyUrl = process.env.ALLOY_URL;
  delete process.env.ALLOY_URL;
  process.env.LOG_LEVEL = "info";
  // The Loki sink is where the emitted record is observable without
  // depending on the stdout formatting.
  _setLokiSink(captureSink());
});

afterEach(() => {
  for (const link of links) link.terminate();
  _setLokiSink(null);
  vi.restoreAllMocks();
  if (origLogLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = origLogLevel;
  if (origAlloyUrl === undefined) delete process.env.ALLOY_URL;
  else process.env.ALLOY_URL = origAlloyUrl;
});

describe("WorkerLink slow-request log", () => {
  test("names the DB and space from the route the link stamped", async () => {
    const link = new WorkerLink(WORKER_PATH, "space-2");
    links.push(link);

    await sendThrough(
      link,
      { type: "query", sql: "select 1", mode: "get" },
      { targetDb: "space", spaceDid: "did:plc:routed" },
    );

    const record = lastSlowLog();
    expect(record.targetDb).toBe("space");
    expect(record.spaceDid).toBe("did:plc:routed");
    expect(record.worker).toBe("space-2");
  });

  test("keeps a spaceDid the request body itself carries", async () => {
    const link = new WorkerLink(WORKER_PATH, "global");
    links.push(link);

    await sendThrough(link, {
      type: "backfillEntitySpace",
      spaceDid: "did:plc:body",
    });

    const record = lastSlowLog();
    expect(record.spaceDid).toBe("did:plc:body");
    // No route on this link, so the target falls back to the request default.
    expect(record.targetDb).toBe("events");
  });

  test("a route target wins over one carried in the body, as the merge does", async () => {
    const link = new WorkerLink(WORKER_PATH, "space-0");
    links.push(link);

    await sendThrough(
      link,
      { type: "query", sql: "select 1", mode: "all", targetDb: "main" },
      { targetDb: "space", spaceDid: "did:plc:routed" },
    );

    const record = lastSlowLog();
    expect(record.targetDb).toBe("space");
    expect(record.spaceDid).toBe("did:plc:routed");
  });
});

describe("WorkerLink request shape", () => {
  test("posts the merged route on the wire, unchanged by the bookkeeping", async () => {
    const link = new WorkerLink(WORKER_PATH, "space-1");
    links.push(link);

    const received = await sendThrough(
      link,
      { type: "query", sql: "select 1", mode: "get" },
      { targetDb: "space", spaceDid: "did:plc:routed" },
    );

    expect(received.targetDb).toBe("space");
    expect(received.spaceDid).toBe("did:plc:routed");
    expect(received.sql).toBe("select 1");
    expect(typeof received.id).toBe("string");
  });
});
