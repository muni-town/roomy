import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  StreamDid,
  type EventCallback,
  type StreamIndex,
} from "@roomy-space/sdk";

import { toAsyncDb } from "../db/syncAdapter.ts";
import type { DbLike } from "../db/types.ts";
import {
  _resetMaterializerRegistry,
  getOrCreateMaterializer,
} from "./registry.ts";
import type { ConnectedSpaceLike } from "./SpaceMaterializer.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMA_PATH = join(__dirname, "..", "db", "schema.sql");
const SCHEMA_VERSION = "10-appserver.4";

const STREAM = StreamDid.assert("did:web:registry-test.example");

function freshDb(): { db: Database; asyncDb: DbLike } {
  const db = new Database(":memory:");
  db.exec("pragma journal_mode = wal");
  db.exec("pragma synchronous = normal");
  db.exec("pragma foreign_keys = on");
  const schemaSql = readFileSync(SCHEMA_PATH, "utf8");
  db.exec(schemaSql);
  db.run("insert into roomy_schema_version (id, version) values (1, ?)", [SCHEMA_VERSION]);
  return { db, asyncDb: toAsyncDb(db) };
}
function makeFakeSpace(streamDid: StreamDid): ConnectedSpaceLike {
  return {
    streamDid,
    subscribe: ((_cb: EventCallback, _start: StreamIndex) => {
      return new Promise(() => {}); // never resolves; test doesn't need backfill
    }) as ConnectedSpaceLike["subscribe"],
    unsubscribe: () => Promise.resolve(),
  };
}

describe("getOrCreateMaterializer", () => {
  test("dedupes concurrent calls for the same stream", async () => {
    _resetMaterializerRegistry();
    const { db, asyncDb } = freshDb();

    let calls = 0;
    const getConnectedSpace = async (s: StreamDid) => {
      calls++;
      return makeFakeSpace(s);
    };

    const [a, b] = await Promise.all([
      getOrCreateMaterializer(STREAM, { db: asyncDb, getConnectedSpace }),
      getOrCreateMaterializer(STREAM, { db: asyncDb, getConnectedSpace }),
    ]);

    expect(calls).toBe(1);
    expect(a).toBe(b);
  });

  test("returns the cached instance on subsequent calls", async () => {
    _resetMaterializerRegistry();
    const { db, asyncDb } = freshDb();
    const getConnectedSpace = async (s: StreamDid) => makeFakeSpace(s);

    const a = await getOrCreateMaterializer(STREAM, {
      db: asyncDb,
      getConnectedSpace,
    });
    const b = await getOrCreateMaterializer(STREAM, {
      db: asyncDb,
      getConnectedSpace,
    });
    expect(a).toBe(b);
  });

  test("evicts cache on startup failure so the next call can retry", async () => {
    _resetMaterializerRegistry();
    const { db, asyncDb } = freshDb();

    let attempt = 0;
    const getConnectedSpace = async (s: StreamDid) => {
      attempt++;
      if (attempt === 1) throw new Error("boom");
      return makeFakeSpace(s);
    };

    await expect(
      getOrCreateMaterializer(STREAM, { db: asyncDb, getConnectedSpace }),
    ).rejects.toThrow("boom");

    const mat = await getOrCreateMaterializer(STREAM, {
      db: asyncDb,
      getConnectedSpace,
    });
    expect(mat.streamDid).toBe(STREAM);
    expect(attempt).toBe(2);
  });
})
