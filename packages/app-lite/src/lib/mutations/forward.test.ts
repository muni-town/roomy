/**
 * Multi-forward ordering.
 *
 * The destination room must show the forwarded messages in the SOURCE room's
 * timeline order, oldest → newest. The selection is kept in tap order
 * (`toggleMessageSelection`), so a user who selects a newer message before an
 * older one would otherwise cross-post them in that click order. Targets are
 * therefore sorted by the source room's timeline key, and the batch is sent in
 * that order — the log position breaks the tie between forwards sharing a
 * millisecond, so no timestamp of the client's own is involved.
 *
 * These tests pin that order and the absence of any override: a
 * `timestampOverride` is a space-admin extension, and a forward is an
 * ordinary sender's write.
 *
 * Written against `node:test` + `node:assert` (available without adding a
 * dependency to app-lite; app-lite ships no test runner of its own) so the
 * file runs under both `bun test` and `node --test --experimental-strip-types`.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  buildForwardEvents,
  MAX_EVENTS_PER_SEND,
  orderForwardTargets,
  type ForwardTarget,
} from "./forward.ts";

/** Timeline keys the source room would return, oldest → newest. */
const TIMELINE = [
  "01M300000000000000000000A1",
  "01M300000000000000000000A2",
  "01M300000000000000000000A3",
  "01M300000000000000000000A4",
];

const target = (index: number, sortIdx: string | undefined = TIMELINE[index]) => ({
  id: `msg-${index}`,
  ...(sortIdx === undefined ? {} : { sort_idx: sortIdx }),
});

interface ForwardEvent {
  id: string;
  room: string;
  extensions: Record<string, unknown> & {
    "space.roomy.extension.attachments.v0": {
      attachments: Array<{ target: string; fromRoomId: string }>;
    };
  };
}

const forwardedTargetOf = (event: Record<string, unknown>): string =>
  (event as unknown as ForwardEvent).extensions[
    "space.roomy.extension.attachments.v0"
  ].attachments[0]!.target;

describe("orderForwardTargets", () => {
  test("sorts a click-ordered selection into source-timeline order", () => {
    // The user selected newest-first: 3, then 1, then 0, then 2.
    const selection: ForwardTarget[] = [
      target(3),
      target(1),
      target(0),
      target(2),
    ];
    assert.deepEqual(
      orderForwardTargets(selection).map((t) => t.id),
      ["msg-0", "msg-1", "msg-2", "msg-3"],
    );
  });

  test("an already-ordered selection is unchanged", () => {
    const ordered = TIMELINE.map((_, i) => target(i));
    assert.deepEqual(orderForwardTargets(ordered).map((t) => t.id), [
      "msg-0",
      "msg-1",
      "msg-2",
      "msg-3",
    ]);
  });

  test("a target without a sort key sorts by its id, like the reader does", () => {
    // A system message carries no `sort_idx`; the reader falls back to the id.
    const bare = target(0, undefined);
    const selection = [
      { id: "01M300000000000000000000A5" },
      bare,
      { id: "01M300000000000000000000A4" },
    ];
    assert.deepEqual(orderForwardTargets(selection).map((t) => t.id), [
      "msg-0",
      "01M300000000000000000000A4",
      "01M300000000000000000000A5",
    ]);
  });

  test("does not mutate the caller's selection", () => {
    const selection = [target(1), target(0)];
    orderForwardTargets(selection);
    assert.deepEqual(selection.map((t) => t.id), ["msg-1", "msg-0"]);
  });
});

describe("buildForwardEvents", () => {
  const FROM = "room-source";
  const TO = "room-destination";

  test("orders the events by the source timeline, not the click order", () => {
    const events = buildForwardEvents(
      FROM,
      TO,
      [target(2), target(0), target(3), target(1)],
      [],
    );
    assert.deepEqual(events.map(forwardedTargetOf), [
      "msg-0",
      "msg-1",
      "msg-2",
      "msg-3",
    ]);
  });

  test("carries no timestamp override", () => {
    // Rewriting a message's timeline position is a space-admin extension, and
    // a forward is an ordinary sender's write. The destination order comes
    // from the batch's log position, so nothing here needs one.
    const events = buildForwardEvents(FROM, TO, [target(0), target(1)], []);
    for (const event of events) {
      assert.equal(
        (event as unknown as ForwardEvent).extensions[
          "space.roomy.extension.timestampOverride.v0"
        ],
        undefined,
      );
    }
  });

  test("emits the same order regardless of click order", () => {
    const ordered = buildForwardEvents(FROM, TO, [target(0), target(1)], []);
    const reversed = buildForwardEvents(FROM, TO, [target(1), target(0)], []);
    assert.deepEqual(reversed.map(forwardedTargetOf), ordered.map(forwardedTargetOf));
    assert.deepEqual(reversed.map(forwardedTargetOf), ["msg-0", "msg-1"]);
  });

  test("each event is its own message in the destination room", () => {
    const events = buildForwardEvents(FROM, TO, [target(0), target(1)], []);
    assert.equal(new Set(events.map((e) => e.id)).size, 2);
    for (const event of events) {
      assert.equal(event.room, TO);
      assert.equal(event.$type, "space.roomy.message.createMessage.v0");
      assert.equal(
        (event as unknown as ForwardEvent).extensions[
          "space.roomy.extension.attachments.v0"
        ].attachments[0]!.fromRoomId,
        FROM,
      );
    }
  });

  test("an empty selection produces no events", () => {
    assert.deepEqual(buildForwardEvents(FROM, TO, [], []), []);
  });
});

describe("MAX_EVENTS_PER_SEND", () => {
  test("matches the appserver's sendEvents cap", () => {
    // `space.roomy.space.sendEvents` rejects a batch larger than this.
    assert.equal(MAX_EVENTS_PER_SEND, 50);
  });
});
