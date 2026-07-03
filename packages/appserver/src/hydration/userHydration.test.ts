import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { StreamDid, UserDid } from "@roomy-space/sdk";

import { toAsyncDb } from "../db/syncAdapter.ts";
import type { DbLike } from "../db/types.ts";
import {
  _resetHydrationInflight,
  hydrateUserMembership,
} from "./userHydration.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMA_PATH = join(__dirname, "..", "db", "schema.sql");
const SCHEMA_VERSION = "10-appserver.4";

const USER = UserDid.assert("did:plc:hydration-user");
const PERSONAL = StreamDid.assert("did:web:personal.example");
const SPACE_A = StreamDid.assert("did:web:space-a.example");
const SPACE_B = StreamDid.assert("did:web:space-b.example");

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

/**
 * Fake-personal-stream seeding: the production materializer would write these
 * rows from PersonalJoinSpace events. We bypass the materializer here and
 * write the rows directly so we can test hydration in isolation.
 *
 * A joined space is a `joinedSpace` edge from the personal stream; a left
 * space has no such edge (PersonalLeaveSpace deletes it).
 */
function seedPersonalIntent(
  db: Database,
  personalStreamDid: StreamDid,
  joinedSpaces: StreamDid[],
  leftSpaces: StreamDid[] = [],
): void {
  // Entity rows are the FK targets for the joinedSpace edges. Each entity is
  // scoped to its own stream.
  for (const did of [personalStreamDid, ...joinedSpaces, ...leftSpaces]) {
    db.run("insert or ignore into entities (id, stream_id) values (?, ?)", [
      did,
      did,
    ]);
  }
  for (const did of joinedSpaces) {
    db.run(
      "insert or ignore into edges (head, tail, label) values (?, ?, 'joinedSpace')",
      [personalStreamDid, did],
    );
  }
}

describe("hydrateUserMembership", () => {
  test("no personal stream record → empty result", async () => {
    _resetHydrationInflight();
    const { db, asyncDb } = freshDb();

    const result = await hydrateUserMembership(USER, {
      db: asyncDb,
      resolveDid: async () => ({ pdsEndpoint: "https://pds.example" }),
      fetchRecord: async () => null,
    });

    expect(result.personalStreamDid).toBeNull();
    expect(result.intendedSpaceDids).toEqual([]);
    expect(result.hydrationFailures).toEqual([]);
  });

  test("personal stream + two joined spaces → all hydrated", async () => {
    _resetHydrationInflight();
    const { db, asyncDb } = freshDb();

    // Pre-seed personal-stream rows so the SQL for intent picks them up.
    seedPersonalIntent(db, PERSONAL, [SPACE_A, SPACE_B]);

    const result = await hydrateUserMembership(USER, {
      db: asyncDb,
      resolveDid: async () => ({ pdsEndpoint: "https://pds.example" }),
      fetchRecord: async () => ({ id: PERSONAL }),
    });

    expect(result.personalStreamDid).toBe(PERSONAL);
    expect(new Set(result.intendedSpaceDids)).toEqual(
      new Set([SPACE_A, SPACE_B]),
    );
    expect(result.hydrationFailures).toEqual([]);
  });

  test("left spaces (no joinedSpace edge) are excluded from intent", async () => {
    _resetHydrationInflight();
    const { db, asyncDb } = freshDb();

    seedPersonalIntent(db, PERSONAL, [SPACE_A], [SPACE_B]);

    const result = await hydrateUserMembership(USER, {
      db: asyncDb,
      resolveDid: async () => ({ pdsEndpoint: "https://pds.example" }),
      fetchRecord: async () => ({ id: PERSONAL }),
    });

    expect(result.intendedSpaceDids).toEqual([SPACE_A]);
  });

  test("concurrent calls for the same user share an in-flight promise", async () => {
    _resetHydrationInflight();
    const { db, asyncDb } = freshDb();

    seedPersonalIntent(db, PERSONAL, [SPACE_A]);

    let resolveCount = 0;
    let fetchCount = 0;
    const opts = {
      db: asyncDb,
      resolveDid: async () => {
        resolveCount++;
        return { pdsEndpoint: "https://pds.example" };
      },
      fetchRecord: async () => {
        fetchCount++;
        return { id: PERSONAL };
      },
    };

    const [a, b] = await Promise.all([
      hydrateUserMembership(USER, opts),
      hydrateUserMembership(USER, opts),
    ]);

    expect(a).toBe(b);
    expect(resolveCount).toBe(1);
    expect(fetchCount).toBe(1);
  });
});
