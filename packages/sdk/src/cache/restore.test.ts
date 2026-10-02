/**
 * The restore validator: the ordering invariant and the shape checks the plan
 * measured `hydrate` as NOT performing.
 *
 * What is asserted here is the contract, not the plumbing: a list restored in
 * the wrong order is repaired, a row with no server ordering key is dropped
 * rather than rendered somewhere the server never puts it, and the checks are
 * scoped so every other query passes through untouched.
 */
import { describe, expect, it } from "vitest";
import { compareTimelineOrder } from "../sync/diff";
import { validateRestoredEntries } from "./restore";
import type { PersistedEntry } from "./persister";

const MESSAGES = "space.roomy.room.getMessages";

/** A row the schema accepts: the required fields plus `sort_idx`. */
function message(id: string, sortIdx?: string) {
  return {
    id,
    content: id,
    authorDid: "did:plc:alice",
    authorName: "Alice",
    timestamp: "2026-01-01T00:00:00.000Z",
    reactions: [],
    media: [],
    linkEmbeds: [],
    ...(sortIdx === undefined ? {} : { sort_idx: sortIdx }),
  };
}

function entry(roomId: string, state: unknown): PersistedEntry {
  return { key: [MESSAGES, { roomId }], state, at: 1 };
}

const quiet = () => {};

describe("the ordering invariant — a restored list is re-sorted by the server key", () => {
  it("repairs a list stored in the wrong order", () => {
    // `at` agrees with id order; the stored array deliberately does not.
    const restored = validateRestoredEntries(
      [entry("r1", [message("c", "3"), message("a", "1"), message("b", "2")])],
      quiet,
    );
    const ids = (restored[0]?.state as Array<{ id: string }>).map((m) => m.id);
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("orders by sort_idx, not by the id, when the two disagree", () => {
    // A bridged backfill: the ULIDs (ids) run opposite the server's key.
    const restored = validateRestoredEntries(
      [entry("r1", [message("01Z", "1"), message("01A", "2")])],
      quiet,
    );
    const ids = (restored[0]?.state as Array<{ id: string }>).map((m) => m.id);
    expect(ids).toEqual(["01Z", "01A"]);
  });

  it("breaks a sort_idx tie by id, matching the server's keyset tie-break", () => {
    const restored = validateRestoredEntries(
      [
        entry("r1", [
          message("01B", "01S"),
          message("01A", "01S"),
        ]),
      ],
      quiet,
    );
    const ids = (restored[0]?.state as Array<{ id: string }>).map((m) => m.id);
    expect(ids).toEqual(["01A", "01B"]);
  });

  it("agrees with the comparator the diff applicator uses", () => {
    const rows = [message("b", "2"), message("a", "1")];
    const restored = validateRestoredEntries([entry("r1", rows)], quiet);
    const byValidator = (restored[0]?.state as typeof rows).map((m) => m.id);
    const byComparator = [...rows].sort(compareTimelineOrder).map((m) => m.id);
    expect(byValidator).toEqual(byComparator);
  });
});

describe("a row that cannot be placed is dropped, never rendered", () => {
  it("drops a message with no ordering key (its snapshot predates the key)", () => {
    const restored = validateRestoredEntries(
      [entry("r1", [message("a", "1"), message("b")])],
      quiet,
    );
    const ids = (restored[0]?.state as Array<{ id: string }>).map((m) => m.id);
    expect(ids).toEqual(["a"]);
  });

  it("keeps a system message, which the server leaves unsorted", () => {
    const system = { ...message("s"), system: true };
    const restored = validateRestoredEntries(
      [entry("r1", [system, message("a", "1")])],
      quiet,
    );
    expect(restored[0]?.state).toHaveLength(2);
  });

  it("drops a row that does not parse as a Message", () => {
    const restored = validateRestoredEntries(
      [entry("r1", [message("a", "1"), { id: "b" }, 42, null])],
      quiet,
    );
    expect(restored[0]?.state).toHaveLength(1);
    expect((restored[0]?.state as Array<{ id: string }>)[0]?.id).toBe("a");
  });

  it("drops a timeline entry that is not a list", () => {
    expect(validateRestoredEntries([entry("r1", { messages: [] })], quiet)).toEqual(
      [],
    );
  });

  it("drops a non-empty list from which nothing survives", () => {
    expect(validateRestoredEntries([entry("r1", [{ id: "x" }])], quiet)).toEqual(
      [],
    );
  });

  it("keeps an empty list (a room genuinely rendered empty)", () => {
    expect(validateRestoredEntries([entry("r1", [])], quiet)).toHaveLength(1);
  });
});

describe("the validator is scoped to the timeline", () => {
  it("passes other queries through untouched", () => {
    const other: PersistedEntry = {
      key: ["space.roomy.space.getSpaces"],
      state: { spaces: [{ id: "s1" }] },
      at: 7,
    };
    expect(validateRestoredEntries([other], quiet)).toEqual([other]);
  });

  it("does not mutate the entry it was given", () => {
    const original = entry("r1", [message("b", "2"), message("a", "1")]);
    validateRestoredEntries([original], quiet);
    expect((original.state as Array<{ id: string }>).map((m) => m.id)).toEqual([
      "b",
      "a",
    ]);
  });
});
