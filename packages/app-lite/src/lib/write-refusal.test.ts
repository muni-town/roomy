/**
 * Recovering from a refused send.
 *
 * The failure this defends: every query holds `staleTime: Infinity` and is
 * refreshed by WebSocket invalidation alone, so a room whose grant is revoked
 * mid-session keeps `canWrite: true` in the cache. The composer goes on
 * offering Send, the appserver refuses each one with a 403, and the user is
 * told only "Message not sent" — with the composer still there to send into.
 *
 * The catch path must therefore read the refusal off the error the transport
 * attaches (`status` + `nsid`, never the prose), invalidate the metadata the
 * composer derives `canWrite` from, and leave the composer showing the
 * permission notice instead of offering Send again on the unchanged grant.
 *
 * Written against `node:test` + `node:assert` (available without adding a
 * dependency to app-lite; app-lite ships no test runner of its own) so the
 * file runs under both `bun test` and `node --test --experimental-strip-types`.
 */

import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { cache } from "@roomy-space/sdk";
import {
  composerCanWrite,
  isWriteRefusal,
  recoverFromWriteRefusal,
  refreshWriteRefusal,
  writeRefused,
} from "./write-refusal.svelte.ts";

const ROOM = "01M3FNAH67FWM3BGP8G289PTX9";
const OTHER_ROOM = "01M2QW5A6Q3QQ8PWP07FZH3KRV";

/** The refusal the appserver returns for a room the caller cannot write to. */
function writeRefusedError(): Error {
  const err = new Error(
    "XRPC space.roomy.space.sendEvents failed (403): Caller does not have write access to this room",
  );
  return Object.assign(err, {
    status: 403,
    errorType: "Forbidden",
    nsid: "space.roomy.space.sendEvents",
  });
}

/** The fields `DirectXrpcClient`'s `toXrpcError` attaches to any XRPC failure. */
function xrpcError(nsid: string, status: number): Error {
  return Object.assign(new Error(`XRPC ${nsid} failed (${status})`), {
    status,
    nsid,
  });
}

/** Collect the keys an invalidation was requested for. */
function recordingInvalidator() {
  const requested: (readonly unknown[])[] = [];
  return {
    requested,
    invalidator: {
      invalidateQueries(filters: { queryKey: readonly unknown[] }) {
        requested.push(filters.queryKey);
      },
    },
  };
}

beforeEach(() => {
  // The refusal registry is module-level and shared; each test starts from a
  // room that has not refused anything.
  refreshWriteRefusal(ROOM, Number.POSITIVE_INFINITY, true);
  refreshWriteRefusal(OTHER_ROOM, Number.POSITIVE_INFINITY, true);
});

describe("isWriteRefusal", () => {
  test("recognises the refusal the appserver returns for a room", () => {
    assert.equal(isWriteRefusal(writeRefusedError()), true);
  });

  test("does not match a 403 from another procedure", () => {
    // An admin-only action refused with "Caller is not a space admin" is not a
    // statement that the room is unwritable, so the composer must keep working.
    assert.equal(
      isWriteRefusal(xrpcError("space.roomy.space.getInvites", 403)),
      false,
    );
  });

  test("does not match a sendEvents failure that is not a refusal", () => {
    // A 409 (space being rematerialized) is retryable and says nothing about
    // the caller's access.
    assert.equal(
      isWriteRefusal(xrpcError("space.roomy.space.sendEvents", 409)),
      false,
    );
  });

  test("does not match a failure carrying no XRPC fields", () => {
    // An upload failure and a network error both surface with no `status`, and
    // neither is evidence about access.
    assert.equal(isWriteRefusal(new Error("Network request failed")), false);
    assert.equal(isWriteRefusal(undefined), false);
    assert.equal(isWriteRefusal(null), false);
    assert.equal(isWriteRefusal("XRPC ... failed (403)"), false);
  });
});

describe("recoverFromWriteRefusal", () => {
  test("invalidates the metadata the composer derives canWrite from", () => {
    const { requested, invalidator } = recordingInvalidator();
    const handled = recoverFromWriteRefusal(
      writeRefusedError(),
      ROOM,
      invalidator,
    );

    assert.equal(handled, true);
    assert.deepEqual(requested, [
      cache.queryKey("space.roomy.room.getMetadata", { roomId: ROOM }),
      ["space.roomy.space.getMetadata"],
    ]);
  });

  test("leaves a non-refusal untouched", () => {
    const { requested, invalidator } = recordingInvalidator();
    const handled = recoverFromWriteRefusal(
      xrpcError("space.roomy.space.sendEvents", 409),
      ROOM,
      invalidator,
    );

    assert.equal(handled, false);
    assert.deepEqual(requested, []);
    assert.equal(writeRefused(ROOM), false);
  });

  test("stops the composer offering Send for the refused room only", () => {
    const { invalidator } = recordingInvalidator();
    recoverFromWriteRefusal(writeRefusedError(), ROOM, invalidator);

    // `false` is `ChatInputShell`'s permission notice: the composer is gone.
    assert.equal(composerCanWrite(ROOM, true), false);
    // A refusal in one room says nothing about any other room.
    assert.equal(composerCanWrite(OTHER_ROOM, true), true);
  });
});

describe("refreshWriteRefusal", () => {
  test("keeps the notice until the metadata behind canWrite is re-read", () => {
    const { invalidator } = recordingInvalidator();
    recoverFromWriteRefusal(writeRefusedError(), ROOM, invalidator);

    // Nothing has answered yet: the cached `canWrite: true` is the stale value
    // the refusal disproved, so the composer must not act on it again.
    assert.equal(composerCanWrite(ROOM, true), false);
  });

  test("hands the composer back once a later fetch reports the room writable", () => {
    const { invalidator } = recordingInvalidator();
    recoverFromWriteRefusal(writeRefusedError(), ROOM, invalidator);

    // The refetch came back and agrees the room is writable (the grant was
    // restored mid-session): the server's answer decides from here.
    refreshWriteRefusal(ROOM, Date.now() + 1, true);

    assert.equal(composerCanWrite(ROOM, true), true);
    assert.equal(composerCanWrite(ROOM, false), false);
  });

  test("a fetch that still reports the room unwritable keeps the notice", () => {
    const { invalidator } = recordingInvalidator();
    recoverFromWriteRefusal(writeRefusedError(), ROOM, invalidator);

    // The refetch succeeded and confirms the denial. It is newer than the
    // refusal, but it is the same answer the send got — so the composer stays
    // replaced rather than re-offering Send into a room that just refused it.
    refreshWriteRefusal(ROOM, Date.now() + 1, false);

    assert.equal(composerCanWrite(ROOM, false), false);
  });

  test("a fetch from before the refusal does not re-enable the composer", () => {
    const { invalidator } = recordingInvalidator();
    const beforeRefetch = Date.now();
    recoverFromWriteRefusal(writeRefusedError(), ROOM, invalidator);

    // A fetch that errored leaves the query's `dataUpdatedAt` at its previous
    // value — here, from before the refusal. Treating that as "answered" would
    // re-enable Send against the very grant that was just refused.
    refreshWriteRefusal(ROOM, beforeRefetch - 1000, true);

    assert.equal(composerCanWrite(ROOM, true), false);
  });

  test("one refusal covers repeated attempts on the unchanged grant", () => {
    const { invalidator } = recordingInvalidator();
    let refusals = 0;
    for (let i = 0; i < 5; i++) {
      // A press is only reachable while the composer offers Send. After the
      // first refusal it does not, so the appserver sees exactly one refused
      // send rather than one per press.
      if (composerCanWrite(ROOM, true) !== true) continue;
      if (recoverFromWriteRefusal(writeRefusedError(), ROOM, invalidator)) {
        refusals++;
      }
    }
    assert.equal(refusals, 1);
  });
});
