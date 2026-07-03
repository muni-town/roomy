import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { StreamDid, UserDid } from "@roomy-space/sdk";

import { toAsyncDb } from "../db/syncAdapter.ts";
import type { DbLike } from "../db/types.ts";
import {
  PersonalStreamRecordNotFound,
  readCachedPersonalStreamDid,
  resolvePersonalStreamDid,
} from "./resolvePersonalStream.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMA_PATH = join(__dirname, "..", "db", "schema.sql");
const SCHEMA_VERSION = "10-appserver.4";

const USER = UserDid.assert("did:plc:fake-user-pstream");
const PERSONAL = StreamDid.assert("did:web:fake-personal.example");

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

describe("resolvePersonalStreamDid", () => {
  test("cache hit short-circuits resolution", async () => {
    const { db, asyncDb } = freshDb();
    db.run(
      "insert into comp_user_personal_stream (user_did, personal_stream_did, resolved_at) values (?, ?, ?)",
      [USER, PERSONAL, Date.now()],
    );

    let resolveCalled = false;
    let fetchCalled = false;
    const result = await resolvePersonalStreamDid(asyncDb, USER, {
      resolveDid: async () => {
        resolveCalled = true;
        return { pdsEndpoint: "https://example" };
      },
      fetchRecord: async () => {
        fetchCalled = true;
        return { id: PERSONAL };
      },
    });

    expect(result).toBe(PERSONAL);
    expect(resolveCalled).toBe(false);
    expect(fetchCalled).toBe(false);
  });

  test("cache miss → resolves and caches", async () => {
    const { db, asyncDb } = freshDb();

    const result = await resolvePersonalStreamDid(asyncDb, USER, {
      resolveDid: async () => ({ pdsEndpoint: "https://pds.example" }),
      fetchRecord: async () => ({ id: PERSONAL }),
    });

    expect(result).toBe(PERSONAL);
    expect(await readCachedPersonalStreamDid(asyncDb, USER)).toBe(PERSONAL);
  });

  test("no record → throws PersonalStreamRecordNotFound", async () => {
    const { db, asyncDb } = freshDb();

    let thrown: unknown = null;
    try {
      await resolvePersonalStreamDid(asyncDb, USER, {
        resolveDid: async () => ({ pdsEndpoint: "https://pds.example" }),
        fetchRecord: async () => null,
      });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(PersonalStreamRecordNotFound);
    expect(await readCachedPersonalStreamDid(asyncDb, USER)).toBeUndefined();
  });

  test("malformed record id → throws", async () => {
    const { db, asyncDb } = freshDb();

    let thrown: unknown = null;
    try {
      await resolvePersonalStreamDid(asyncDb, USER, {
        resolveDid: async () => ({ pdsEndpoint: "https://pds.example" }),
        fetchRecord: async () => ({ id: "not-a-did" }),
      });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(Error);
  });
});
