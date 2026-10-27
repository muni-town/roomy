/**
 * Bulk delete and move, and the tile count a send reports.
 *
 * Bulk operations expand a selection into one event per message, and
 * `space.roomy.space.sendEvents` rejects a batch larger than
 * `MAX_EVENTS_PER_SEND` as a whole. These tests pin the two properties that
 * make a large selection work: the events are split into cap-sized calls in
 * input order, and a rejected call reaches the caller instead of being
 * swallowed or retried.
 *
 * A delivered message reports the tiles it carries once, from both places a
 * tile can arrive — the addresses its body spells out and its tile
 * attachments — and reports nothing for a message without one or for a send
 * that failed.
 *
 * `message.ts` reaches the network through `./send-events` and pulls in the
 * auth/Svelte/telemetry modules it shares with the composer. The send is
 * replaced with a recorder here, and the unrelated imports with inert
 * stand-ins, so the functions run under the plain
 * `node --test --experimental-strip-types` runner the package uses.
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
const TILE_EVENTS = "test-stub:tile-events";
const TILE_MESSAGE_HELPERS =
  "@roomy/design/components/content/thread/message/tiles/message-tiles.js";
const TILE_MESSAGE_HELPERS_SOURCE = new URL(
  "../../../../design/src/components/content/thread/message/tiles/message-tiles.ts",
  import.meta.url,
).href;

/**
 * The recorder lives on `globalThis` because a virtual module's source is a
 * string: this is how the test and the stub share one array.
 */
interface SendEventsRecorder {
  calls: Array<{ spaceId: string; events: Array<Record<string, unknown>> }>;
  /** 1-based call index that rejects; undefined sends everything. */
  failAt?: number;
  /** Every `tile_post` the send path emitted. */
  tilePosts: Array<{ count: number; source: string }>;
}

declare global {
  var __sendEventsRecorder: SendEventsRecorder | undefined;
}

const recorder = (globalThis.__sendEventsRecorder ??= { calls: [], tilePosts: [] });

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
    export function startPendingSend() {
      return { id: "01J8ZQ6ZC4N5V3M0T7R2K9XBQD", event: {} };
    }
    export function confirmPendingSend() {}
    export function failPendingSend() {}
  `,
  [WRITE_REFUSAL]: `export function isRematerialising() { return false; }`,
  [TILE_EVENTS]: `
    const state = globalThis.__sendEventsRecorder;
    export function trackTilePost(count, source) {
      state.tilePosts.push({ count, source });
    }
  `,
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
    if (specifier === "$lib/telemetry/tile-events") {
      return { url: TILE_EVENTS, shortCircuit: true, format: "module" };
    }
    // The tile scanner is what counts the addresses, so it is loaded from its
    // real source; its `.js` subpath only exists as `.ts`.
    if (specifier === TILE_MESSAGE_HELPERS) {
      return { url: TILE_MESSAGE_HELPERS_SOURCE, shortCircuit: true };
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
      // A sibling imported as `./x.js` that ships as `./x.ts`.
      if (target.endsWith(".js") && existsSync(`${target.slice(0, -3)}.ts`)) {
        return {
          url: pathToFileURL(`${target.slice(0, -3)}.ts`).href,
          shortCircuit: true,
        };
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

const { deleteMessages, moveMessages, sendMessage } = await import("./message.ts");

const ids = (count: number) => Array.from({ length: count }, (_, i) => `msg-${i}`);

/** The ids each event targets, in call then event order. */
const targetedIds = (field: "messageId" | "messageIds") =>
  recorder.calls.flatMap((call) =>
    call.events.map((event) => {
      const value = event[field];
      return Array.isArray(value) ? value[0] : value;
    }),
  );

/** A body block whose text is `text`. */
const text = (value: string) => ({
  $type: "space.roomy.richtext.blocks#text",
  text: value,
});

const TILE = "at://did:plc:izttpdp3l6vss5crelt5kcux/ing.dasl.masl/3mcjwwoqjqs2v";
const OTHER_TILE =
  "at://did:plc:izttpdp3l6vss5crelt5kcux/ing.dasl.masl/3meggnybzqs2n";

/** A tile attachment, as the composer builds one. */
const tileAttachment = { $type: "space.roomy.attachment.tile.v0", url: TILE };

beforeEach(() => {
  recorder.calls.length = 0;
  recorder.failAt = undefined;
  recorder.tilePosts.length = 0;
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

describe("sendMessage tile reporting", () => {
  const send = async (opts: Parameters<typeof sendMessage>[2]) =>
    sendMessage("space-1", "room-1", opts);

  test("a body that spells out one address reports one inline tile", async () => {
    await send({ blocks: [text(`look at ${TILE}`)] });
    assert.deepEqual(recorder.tilePosts, [{ count: 1, source: "inline" }]);
  });

  test("a tile attachment reports one attachment tile", async () => {
    await send({ blocks: [text("look at this")], attachments: [tileAttachment] });
    assert.deepEqual(recorder.tilePosts, [{ count: 1, source: "attachment" }]);
  });

  test("both sources together are one attachment-sourced count", async () => {
    await send({
      blocks: [text(`${TILE} and ${OTHER_TILE}`)],
      attachments: [tileAttachment],
    });
    assert.deepEqual(recorder.tilePosts, [{ count: 3, source: "attachment" }]);
  });

  test("a message without tiles reports nothing", async () => {
    await send({ blocks: [text("no tiles here")] });
    assert.deepEqual(recorder.tilePosts, []);
  });

  test("the count stops at MAX_TILES_PER_MESSAGE", async () => {
    const many = Array.from(
      { length: 6 },
      (_, i) => `at://did:plc:izttpdp3l6vss5crelt5kcux/ing.dasl.masl/3mcjwwoqjqs${i}`,
    );
    await send({ blocks: [text(many.join(" "))] });
    assert.deepEqual(recorder.tilePosts, [{ count: 4, source: "inline" }]);
  });

  test("a failed send reports nothing", async () => {
    recorder.failAt = 1;
    await assert.rejects(() => send({ blocks: [text(TILE)] }), /at most length 50/);
    assert.deepEqual(recorder.tilePosts, []);
  });
});
