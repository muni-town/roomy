/**
 * Unit tests for ConnectedSpace backfill liveness.
 *
 * Regression: the original `doneBackfilling` promise was never settled when
 * Leaf (a) returned a Subscribe query error or (b) disconnected and never
 * reconnected / stopped sending pages. A hung promise stranded any bounded
 * backfill worker pool — one bad stream permanently occupied a worker. These
 * tests pin the fix: `doneBackfilling` (exposed via `subscribe()`'s return)
 * must reject on error and on inactivity, never hang.
 *
 * A live Leaf is not required: we inject a stub LeafClient whose
 * `subscribeEvents` drives the result callback deterministically.
 */

import { describe, expect, test } from "vitest";
import type { LeafClient } from "@muni-town/leaf-client";

import { ConnectedSpace, modules, type StreamDid } from "../../src";

const STREAM_DID = "did:web:test.example" as StreamDid;

/** A LeafClient stub that never calls the subscribe handler (simulates a stall). */
function stalledLeaf(): LeafClient {
  const handlers = new Map<string, Set<(...a: unknown[]) => void>>();
  return {
    on: (event: string, handler: (...a: unknown[]) => void) => {
      let set = handlers.get(event);
      if (!set) {
        set = new Set();
        handlers.set(event, set);
      }
      set.add(handler);
    },
    off: () => {},
    streamInfo: async () => ({ moduleCid: "matching-cid" }),
    hasModule: async () => true,
    uploadModule: async () => ({ moduleCid: "matching-cid" }),
    updateModule: async () => ({ Ok: {} }),
    subscribeEvents: async () => {
      // Never invokes the handler — backfill receives no pages.
      return async () => {};
    },
  } as unknown as LeafClient;
}

/** Build a ConnectedSpace against a stub Leaf, matching module CIDs so connect
 *  skips the module-upload/update path. */
async function makeSpace(leaf: LeafClient): Promise<ConnectedSpace> {
  const module = modules.space;
  // Force the module CID to match streamInfo's reported CID so connect()
  // doesn't try hasModule/uploadModule/updateModule against the stub.
  const stubModule = { def: module.def, cid: Promise.resolve("matching-cid") };
  return ConnectedSpace.connect({
    // The client only needs `.leaf` for connect(); cast the minimal stub.
    client: { leaf } as unknown as Parameters<
      typeof ConnectedSpace.connect
    >[0]["client"],
    streamDid: STREAM_DID,
    module: stubModule,
  });
}

describe("ConnectedSpace backfill liveness", () => {
  test("subscribe() rejects on inactivity when Leaf stops sending (no hang)", async () => {
    // Short timeout so the test is fast. Read lazily inside the SDK.
    process.env.LEAF_BACKFILL_INACTIVITY_TIMEOUT_MS = "50";
    const space = await makeSpace(stalledLeaf());

    await expect(
      space.subscribe(() => {
        /* no events will arrive */
      }),
    ).rejects.toThrow(/backfill inactivity timeout/);

    expect(space.backfillStatus.status).toBe("errored");
    delete process.env.LEAF_BACKFILL_INACTIVITY_TIMEOUT_MS;
  });

  test("subscribe() rejects (no hang) when Leaf returns a Subscribe query error", async () => {
    const leaf = stalledLeaf();
    // Override subscribeEvents to deliver a single Err result, then stall.
    (leaf as unknown as { subscribeEvents: unknown }).subscribeEvents =
      async (
        _did: string,
        _q: unknown,
        handler: (r: { Err: string }) => void,
      ) => {
        // Deliver the error after subscribe() returns (Leaf delivers results
        // over the websocket, not before the subscribe call resolves). Use a
        // macrotask so it lands after subscribe sets status="started".
        setTimeout(() => handler({ Err: "leaf internal error" }), 0);
        return async () => {};
      };
    const space = await makeSpace(leaf);

    await expect(
      space.subscribe(() => {
        /* handler errors before any event */
      }),
    ).rejects.toThrow(/Subscribe query error/);

    expect(space.backfillStatus.status).toBe("errored");
  });
});