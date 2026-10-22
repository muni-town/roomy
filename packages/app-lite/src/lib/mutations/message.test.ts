/**
 * Bulk delete and move.
 *
 * Both expand a selection into one event per message, and
 * `space.roomy.space.sendEvents` rejects a batch larger than
 * `MAX_EVENTS_PER_SEND` as a whole. These tests pin the two properties that
 * make a large selection work: the events are split into cap-sized calls in
 * input order, and a rejected call reaches the caller instead of being
 * swallowed or retried.
 *
 * `message.ts` reaches the network through `./send-events` and pulls in the
 * auth/Svelte modules it shares with the composer. The send is replaced with a
 * recorder here, and the unrelated imports with inert stand-ins, so the
 * functions run under the plain `node --test --experimental-strip-types` runner
 * the package uses.
 */

import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const SEND_EVENTS = "test-stub:send-events";
const AUTH = "test-stub:auth";
const PENDING_SENDS = "test-stub:pending-sends";
const WRITE_REFUSAL = "test-stub:write-refusal";

/**
 * The recorder lives on `globalThis` because a virtual module's source is a
 * string: this is how the test and the stub share one array.
 */
interface SendEventsRecorder {
  calls: Array<{ spaceId: string; events: Array<Record<string, unknown>> }>;
  /** 1-based call index that rejects; undefined sends everything. */
  failAt?: number;
}

declare global {
  var __sendEventsRecorder: SendEventsRecorder | undefined;
}

const recorder = (globalThis.__sendEventsRecorder ??= { calls: [] });

const STUBS: Record<string, string> = {
  [SEND_EVENTS]: `
    const state = globalThis.__sendEventsRecorder;
    export async function sendEvents(spaceId, events) {
      state.calls.push({ spaceId, events });
      if (state.failAt === state.calls.length) {
        throw new Error("events must be at most length 50 (was 71)");
      }
    }
  `,
  [AUTH]: `export const auth = { userDid: "did:plc:test" };`,
  [PENDING_SENDS]: `
    export function startPendingSend() {}
    export function confirmPendingSend() {}
    export function failPendingSend() {}
  `,
  [WRITE_REFUSAL]: `export function isRematerialising() { return false; }`,
};

registerHooks({
  resolve(specifier, context, next) {
    // The one module under test's control.
    if (specifier === "./send-events") {
      return { url: SEND_EVENTS, shortCircuit: true, format: "module" };
    }
    // Imports that exist only to support sending a message, not a bulk
    // delete/move.
    if (specifier === "$lib/auth.svelte") {
      return { url: AUTH, shortCircuit: true, format: "module" };
    }
    if (specifier === "./pending-sends.svelte") {
      return { url: PENDING_SENDS, shortCircuit: true, format: "module" };
    }
    if (specifier === "$lib/write-refusal.svelte") {
      return { url: WRITE_REFUSAL, shortCircuit: true, format: "module" };
    }
    // The sources import their siblings extensionless, as the bundler allows.
    if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
      const target = resolvePath(
        dirname(fileURLToPath(context.parentURL)),
        specifier,
      );
      if (existsSync(`${target}.ts`)) {
        return { url: pathToFileURL(`${target}.ts`).href, shortCircuit: true };
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    const source = STUBS[url];
    if (source) {
      return { format: "module", shortCircuit: true, source };
    }
    return next(url, context);
  },
});

const { deleteMessages, moveMessages } = await import("./message.ts");

const ids = (count: number) => Array.from({ length: count }, (_, i) => `msg-${i}`);

/** The ids each event targets, in call then event order. */
const targetedIds = (field: "messageId" | "messageIds") =>
  recorder.calls.flatMap((call) =>
    call.events.map((event) => {
      const value = event[field];
      return Array.isArray(value) ? value[0] : value;
    }),
  );

beforeEach(() => {
  recorder.calls.length = 0;
  recorder.failAt = undefined;
});

describe("deleteMessages", () => {
  test("splits a selection larger than the cap into cap-sized calls, in order", () => {
    const selection = ids(71);

    return deleteMessages("space-1", "room-1", selection).then(() => {
      assert.deepEqual(
        recorder.calls.map((call) => call.events.length),
        [50, 21],
      );
      assert.deepEqual(targetedIds("messageId"), selection);
      for (const call of recorder.calls) {
        assert.equal(call.spaceId, "space-1");
      }
    });
  });

  test("a selection exactly at the cap is one call", () => {
    const selection = ids(50);

    return deleteMessages("space-1", "room-1", selection).then(() => {
      assert.deepEqual(
        recorder.calls.map((call) => call.events.length),
        [50],
      );
      assert.deepEqual(targetedIds("messageId"), selection);
    });
  });

  test("an empty selection sends nothing", async () => {
    await deleteMessages("space-1", "room-1", []);
    assert.equal(recorder.calls.length, 0);
  });

  test("a rejected call reaches the caller and stops the remaining batches", async () => {
    recorder.failAt = 2;
    const selection = ids(71);

    await assert.rejects(
      () => deleteMessages("space-1", "room-1", selection),
      /at most length 50/,
    );
    // The first batch landed; the failure is reported rather than retried.
    assert.equal(recorder.calls.length, 2);
  });
});

describe("moveMessages", () => {
  test("splits a selection larger than the cap into cap-sized calls, in order", () => {
    const selection = ids(71);

    return moveMessages("space-1", "from-room", selection, "to-room").then(() => {
      assert.deepEqual(
        recorder.calls.map((call) => call.events.length),
        [50, 21],
      );
      assert.deepEqual(targetedIds("messageIds"), selection);
      for (const call of recorder.calls) {
        for (const event of call.events) {
          assert.equal(event.toRoomId, "to-room");
          assert.equal(event.room, "from-room");
        }
      }
    });
  });

  test("a selection exactly at the cap is one call", () => {
    const selection = ids(50);

    return moveMessages("space-1", "from-room", selection, "to-room").then(() => {
      assert.deepEqual(
        recorder.calls.map((call) => call.events.length),
        [50],
      );
      assert.deepEqual(targetedIds("messageIds"), selection);
    });
  });

  test("a rejected call reaches the caller and stops the remaining batches", async () => {
    recorder.failAt = 1;
    const selection = ids(71);

    await assert.rejects(
      () => moveMessages("space-1", "from-room", selection, "to-room"),
      /at most length 50/,
    );
    assert.equal(recorder.calls.length, 1);
  });
});
