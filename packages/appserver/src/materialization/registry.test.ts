import { describe, expect, test } from "bun:test";
import {
  StreamDid,
  type EventCallback,
  type StreamIndex,
} from "@roomy-space/sdk";

import { openDb } from "../db/db.ts";
import {
  _resetMaterializerRegistry,
  getOrCreateMaterializer,
} from "./registry.ts";
import type { ConnectedSpaceLike } from "./SpaceMaterializer.ts";

const STREAM = StreamDid.assert("did:web:registry-test.example");

function makeFakeSpace(streamDid: StreamDid): ConnectedSpaceLike {
  return {
    streamDid,
    subscribe: ((_cb: EventCallback, _start: StreamIndex) => {
      return new Promise(() => {}); // never resolves; test doesn't need backfill
    }) as ConnectedSpaceLike["subscribe"],
  };
}

describe("getOrCreateMaterializer", () => {
  test("dedupes concurrent calls for the same stream", async () => {
    _resetMaterializerRegistry();
    const db = openDb({ path: ":memory:", isolated: true });

    let calls = 0;
    const getConnectedSpace = async (s: StreamDid) => {
      calls++;
      return makeFakeSpace(s);
    };

    const [a, b] = await Promise.all([
      getOrCreateMaterializer(STREAM, { db, getConnectedSpace }),
      getOrCreateMaterializer(STREAM, { db, getConnectedSpace }),
    ]);

    expect(calls).toBe(1);
    expect(a).toBe(b);
  });

  test("returns the cached instance on subsequent calls", async () => {
    _resetMaterializerRegistry();
    const db = openDb({ path: ":memory:", isolated: true });
    const getConnectedSpace = async (s: StreamDid) => makeFakeSpace(s);

    const a = await getOrCreateMaterializer(STREAM, {
      db,
      getConnectedSpace,
    });
    const b = await getOrCreateMaterializer(STREAM, {
      db,
      getConnectedSpace,
    });
    expect(a).toBe(b);
  });

  test("evicts cache on startup failure so the next call can retry", async () => {
    _resetMaterializerRegistry();
    const db = openDb({ path: ":memory:", isolated: true });

    let attempt = 0;
    const getConnectedSpace = async (s: StreamDid) => {
      attempt++;
      if (attempt === 1) throw new Error("boom");
      return makeFakeSpace(s);
    };

    await expect(
      getOrCreateMaterializer(STREAM, { db, getConnectedSpace }),
    ).rejects.toThrow("boom");

    const mat = await getOrCreateMaterializer(STREAM, {
      db,
      getConnectedSpace,
    });
    expect(mat.streamDid).toBe(STREAM);
    expect(attempt).toBe(2);
  });
});
