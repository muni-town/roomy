import { describe, expect, it } from "vitest";
import { applyMessageDiff, type Message, type MessageDiffOp } from "./diff";

/**
 * The message cache's ordering key is the SERVER's, not the sender's.
 *
 * `sort_idx` is what the appserver pages `room.getMessages` by, and a live row
 * arrives through `#messageDiff`. Ordering the merged list by `timestamp`
 * instead would re-sort arrivals by whatever clock the sending device had —
 * the exact input the server-side key exists to ignore — so a diff could put a
 * message somewhere the next HTTP page would not.
 */
function msg(over: Partial<Message> & { id: string }): Message {
  return {
    content: over.id,
    authorDid: "did:plc:alice",
    authorName: "alice",
    timestamp: "2026-01-01T00:00:00.000Z",
    reactions: [],
    media: [],
    linkEmbeds: [],
    ...over,
  };
}

/** A message whose timestamp and sort_idx deliberately disagree. */
function skewed(id: string, sortIdx: string, ageMs: number): Message {
  return msg({
    id,
    sort_idx: sortIdx,
    timestamp: new Date(Date.now() - ageMs).toISOString(),
  });
}

describe("applyMessageDiff ordering", () => {
  it("orders by sort_idx, ignoring a timestamp that claims otherwise", () => {
    const history = [skewed("old", "01A", 0), skewed("middle", "01B", 0)];
    const ops: MessageDiffOp[] = [
      // Newest by the server's key, but its timestamp claims six hours ago.
      { op: "add", key: "newest", message: skewed("newest", "01C", 6 * 3600_000) },
    ];

    expect(applyMessageDiff(history, ops).map((m) => m.id)).toEqual([
      "old",
      "middle",
      "newest",
    ]);
  });

  it("falls back to the id for a row with no sort_idx, as the server does", () => {
    const ops: MessageDiffOp[] = [
      { op: "add", key: "01C", message: msg({ id: "01C" }) },
      { op: "add", key: "01A", message: msg({ id: "01A" }) },
    ];

    expect(applyMessageDiff(undefined, ops).map((m) => m.id)).toEqual([
      "01A",
      "01C",
    ]);
  });

  it("breaks a sort_idx tie by id, matching the keyset page's tie-break", () => {
    const ops: MessageDiffOp[] = [
      { op: "add", key: "01B", message: msg({ id: "01B", sort_idx: "01S" }) },
      { op: "add", key: "01A", message: msg({ id: "01A", sort_idx: "01S" }) },
    ];

    expect(applyMessageDiff(undefined, ops).map((m) => m.id)).toEqual([
      "01A",
      "01B",
    ]);
  });
});
