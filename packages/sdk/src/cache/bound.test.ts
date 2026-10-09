/**
 * What a budget drop reports.
 *
 * The count alone was unattributable: an operator reading "9,238 entries
 * dropped" in the log could not tell which queries were churning through the
 * budget. A drop therefore names the keys it took — a bounded sample of them,
 * so the report does not grow with the drop — while the message stays fixed so
 * every drop still groups as one series.
 */
import { describe, expect, it } from "vitest";
import { boundEntries, DROPPED_KEY_SAMPLE } from "./bound";
import type { PersistedEntry } from "./persister";
import { queryKey } from "./query-key";

/** An entry for a room's message page, written at `at`. */
function messagesEntry(roomId: string, at: number): PersistedEntry {
  return {
    key: queryKey("space.roomy.room.getMessages", { roomId }),
    state: [],
    at,
  };
}

/** The diagnostics one bound call emitted, as message/detail pairs. */
function report(
  entries: readonly PersistedEntry[],
  maxEntries: number,
): Array<{ message: string; detail: unknown }> {
  const seen: Array<{ message: string; detail: unknown }> = [];
  boundEntries(entries, { maxEntries }, (message, detail) =>
    seen.push({ message, detail }),
  );
  return seen;
}

describe("a drop names the keys it took", () => {
  it("reports the evicted keys, not only how many there were", () => {
    const entries = [
      messagesEntry("OLDEST", 1),
      messagesEntry("MIDDLE", 2),
      messagesEntry("NEWEST", 3),
    ];

    const [diagnostic] = report(entries, 1);

    expect(diagnostic?.detail).toContain("space.roomy.room.getMessages");
    expect(diagnostic?.detail).toContain("OLDEST");
    expect(diagnostic?.detail).toContain("MIDDLE");
    // The survivor is not reported as dropped.
    expect(diagnostic?.detail).not.toContain("NEWEST");
  });

  it("names the dropped keys in the budget's own order", () => {
    // The budget ranks newest-first, so of the two dropped here the more
    // recently written (MIDDLE) leads the sample.
    const detail = report(
      [
        messagesEntry("OLDEST", 1),
        messagesEntry("MIDDLE", 2),
        messagesEntry("NEWEST", 3),
      ],
      1,
    )[0]?.detail as string;

    expect(detail.indexOf("MIDDLE")).toBeLessThan(detail.indexOf("OLDEST"));
  });

  it("reports the full count however few keys it names", () => {
    const dropped = DROPPED_KEY_SAMPLE + 6;
    const many = Array.from({ length: dropped + 1 }, (_, i) =>
      messagesEntry(`ROOM-${i}`, i),
    );

    const [diagnostic] = report(many, 1);
    const detail = diagnostic?.detail as string;

    expect(detail).toContain(`${dropped} dropped`);
    // The sample is bounded to the newest of the dropped: the oldest is
    // covered by the count alone rather than named.
    expect(detail).toContain(`(+${dropped - DROPPED_KEY_SAMPLE} more)`);
    expect(detail).not.toContain("ROOM-0");
  });
});

describe("every drop reports under one message", () => {
  it("does not vary the message with the count, so drops group together", () => {
    const small = report([messagesEntry("a", 1), messagesEntry("b", 2)], 1)[0];
    const large = report(
      Array.from({ length: 40 }, (_, i) => messagesEntry(`ROOM-${i}`, i)),
      1,
    )[0];

    expect(small?.message).toBe(large?.message);
    expect(small?.message).toContain("cache: dropped");
  });

  it("reports nothing when the set fits the budget", () => {
    expect(report([messagesEntry("a", 1)], 5)).toEqual([]);
  });

  it("reports nothing when no count cap applies", () => {
    const seen: unknown[] = [];
    boundEntries([messagesEntry("a", 1)], {}, (m) => seen.push(m));
    expect(seen).toEqual([]);
  });
});
