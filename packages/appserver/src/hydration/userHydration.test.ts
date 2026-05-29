import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  StreamDid,
  UserDid,
  newUlid,
  type EventCallback,
  type StreamIndex,
} from "@roomy-space/sdk";

import { openDb } from "../db/db.ts";
import {
  _resetMaterializerRegistry,
  type GetOrCreateOpts,
} from "../materialization/registry.ts";
import type { ConnectedSpaceLike } from "../materialization/SpaceMaterializer.ts";
import {
  _resetHydrationInflight,
  hydrateUserMembership,
} from "./userHydration.ts";

const USER = UserDid.assert("did:plc:hydration-user");
const PERSONAL = StreamDid.assert("did:web:personal.example");
const SPACE_A = StreamDid.assert("did:web:space-a.example");
const SPACE_B = StreamDid.assert("did:web:space-b.example");

function freshDb(): Database {
  return openDb({ path: ":memory:", isolated: true });
}

/** Fake space whose backfill resolves immediately. */
function instantSpace(streamDid: StreamDid): ConnectedSpaceLike {
  return {
    streamDid,
    subscribe: ((_cb: EventCallback, _start: StreamIndex) =>
      Promise.resolve(newUlid())) as ConnectedSpaceLike["subscribe"],
  };
}

function failingSpace(streamDid: StreamDid, msg: string): ConnectedSpaceLike {
  return {
    streamDid,
    subscribe: ((_cb: EventCallback, _start: StreamIndex) =>
      Promise.reject(new Error(msg))) as ConnectedSpaceLike["subscribe"],
  };
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
) {
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
    _resetMaterializerRegistry();
    _resetHydrationInflight();
    const db = freshDb();

    const result = await hydrateUserMembership(USER, {
      db,
      resolveDid: async () => ({ pdsEndpoint: "https://pds.example" }),
      fetchRecord: async () => null,
    });

    expect(result.personalStreamDid).toBeNull();
    expect(result.intendedSpaceDids).toEqual([]);
    expect(result.hydrationFailures).toEqual([]);
  });

  test("personal stream + two joined spaces → all hydrated", async () => {
    _resetMaterializerRegistry();
    _resetHydrationInflight();
    const db = freshDb();

    // Pre-seed personal-stream rows so the SQL for intent picks them up
    // immediately when the personal stream materialiser "settles".
    seedPersonalIntent(db, PERSONAL, [SPACE_A, SPACE_B]);

    const calls: StreamDid[] = [];
    const matOpts: GetOrCreateOpts = {
      db,
      getConnectedSpace: async (s) => {
        calls.push(s);
        return instantSpace(s);
      },
    };

    const result = await hydrateUserMembership(USER, {
      db,
      resolveDid: async () => ({ pdsEndpoint: "https://pds.example" }),
      fetchRecord: async () => ({ id: PERSONAL }),
      materializerOpts: matOpts,
    });

    expect(result.personalStreamDid).toBe(PERSONAL);
    expect(new Set(result.intendedSpaceDids)).toEqual(
      new Set([SPACE_A, SPACE_B]),
    );
    expect(result.hydrationFailures).toEqual([]);
    // Personal stream + both spaces materialised.
    expect(new Set(calls)).toEqual(new Set([PERSONAL, SPACE_A, SPACE_B]));
  });

  test("left spaces (no joinedSpace edge) are excluded from intent", async () => {
    _resetMaterializerRegistry();
    _resetHydrationInflight();
    const db = freshDb();

    seedPersonalIntent(db, PERSONAL, [SPACE_A], [SPACE_B]);

    const result = await hydrateUserMembership(USER, {
      db,
      resolveDid: async () => ({ pdsEndpoint: "https://pds.example" }),
      fetchRecord: async () => ({ id: PERSONAL }),
      materializerOpts: {
        db,
        getConnectedSpace: async (s) => instantSpace(s),
      },
    });

    expect(result.intendedSpaceDids).toEqual([SPACE_A]);
  });

  test("a failing space is recorded but does not throw", async () => {
    _resetMaterializerRegistry();
    _resetHydrationInflight();
    const db = freshDb();

    seedPersonalIntent(db, PERSONAL, [SPACE_A, SPACE_B]);

    const result = await hydrateUserMembership(USER, {
      db,
      resolveDid: async () => ({ pdsEndpoint: "https://pds.example" }),
      fetchRecord: async () => ({ id: PERSONAL }),
      materializerOpts: {
        db,
        getConnectedSpace: async (s) =>
          s === SPACE_B ? failingSpace(s, "leaf down") : instantSpace(s),
      },
    });

    expect(result.intendedSpaceDids.length).toBe(2);
    expect(result.hydrationFailures.length).toBe(1);
    expect(result.hydrationFailures[0]!.streamDid).toBe(SPACE_B);
  });

  test("concurrent calls for the same user share an in-flight promise", async () => {
    _resetMaterializerRegistry();
    _resetHydrationInflight();
    const db = freshDb();

    seedPersonalIntent(db, PERSONAL, [SPACE_A]);

    let resolveCount = 0;
    let fetchCount = 0;
    const opts = {
      db,
      resolveDid: async () => {
        resolveCount++;
        return { pdsEndpoint: "https://pds.example" };
      },
      fetchRecord: async () => {
        fetchCount++;
        return { id: PERSONAL };
      },
      materializerOpts: {
        db,
        getConnectedSpace: async (s: StreamDid) => instantSpace(s),
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
