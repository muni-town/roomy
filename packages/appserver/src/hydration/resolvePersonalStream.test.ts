import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { StreamDid, UserDid } from "@roomy-space/sdk";

import { openDb } from "../db/db.ts";
import {
  PersonalStreamRecordNotFound,
  readCachedPersonalStreamDid,
  resolvePersonalStreamDid,
} from "./resolvePersonalStream.ts";

const USER = UserDid.assert("did:plc:fake-user-pstream");
const PERSONAL = StreamDid.assert("did:web:fake-personal.example");

function freshDb(): Database {
  return openDb({ path: ":memory:", isolated: true });
}

describe("resolvePersonalStreamDid", () => {
  test("cache hit short-circuits resolution", async () => {
    const db = freshDb();
    db.run(
      "insert into comp_user_personal_stream (user_did, personal_stream_did, resolved_at) values (?, ?, ?)",
      [USER, PERSONAL, Date.now()],
    );

    let resolveCalled = false;
    let fetchCalled = false;
    const result = await resolvePersonalStreamDid(db, USER, {
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
    const db = freshDb();

    const result = await resolvePersonalStreamDid(db, USER, {
      resolveDid: async () => ({ pdsEndpoint: "https://pds.example" }),
      fetchRecord: async () => ({ id: PERSONAL }),
    });

    expect(result).toBe(PERSONAL);
    expect(readCachedPersonalStreamDid(db, USER)).toBe(PERSONAL);
  });

  test("no record → throws PersonalStreamRecordNotFound", async () => {
    const db = freshDb();

    let thrown: unknown = null;
    try {
      await resolvePersonalStreamDid(db, USER, {
        resolveDid: async () => ({ pdsEndpoint: "https://pds.example" }),
        fetchRecord: async () => null,
      });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(PersonalStreamRecordNotFound);
    expect(readCachedPersonalStreamDid(db, USER)).toBeUndefined();
  });

  test("malformed record id → throws", async () => {
    const db = freshDb();

    let thrown: unknown = null;
    try {
      await resolvePersonalStreamDid(db, USER, {
        resolveDid: async () => ({ pdsEndpoint: "https://pds.example" }),
        fetchRecord: async () => ({ id: "not-a-did" }),
      });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(Error);
  });
});
