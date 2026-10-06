/**
 * The stale-data rule: which failed queries the UI stays quiet about.
 *
 * Every query in app-lite holds `staleTime: Infinity` and is refreshed by
 * WebSocket invalidation alone, so a refetch that fails is the ordinary case.
 * TanStack keeps `state.data` through that transition (the result reports
 * `isRefetchError`), and the views guard their error branch on there being
 * nothing to fall back on. What that leaves the UI to say is the count this
 * rule produces: the banner's visibility and the sidebar dot's colour.
 *
 * Written against `node:test` + `node:assert` (available without adding a
 * dependency to app-lite; app-lite ships no test runner of its own) so the file
 * runs under both `bun test` and `node --test --experimental-strip-types`.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { countStaleFailures } from "./query-health.ts";

describe("countStaleFailures", () => {
  test("counts a failed refetch that still holds data", () => {
    assert.equal(
      countStaleFailures([{ status: "error", data: [{ id: "m1" }] }]),
      1,
    );
  });

  test("ignores an error with nothing to fall back on", () => {
    // The view renders the failure itself, so there is no stale value to
    // announce.
    assert.equal(countStaleFailures([{ status: "error", data: undefined }]), 0);
  });

  test("ignores healthy queries", () => {
    assert.equal(
      countStaleFailures([
        { status: "success", data: [{ id: "m1" }] },
        { status: "pending", data: undefined },
      ]),
      0,
    );
  });

  test("counts each stale query independently", () => {
    assert.equal(
      countStaleFailures([
        { status: "error", data: { spaces: [] } },
        { status: "success", data: { spaces: [] } },
        { status: "error", data: [] },
        { status: "error", data: undefined },
      ]),
      2,
    );
  });

  test("an empty iterable is no stale data", () => {
    assert.equal(countStaleFailures([]), 0);
  });
});
