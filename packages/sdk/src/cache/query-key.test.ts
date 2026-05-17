import { describe, expect, it } from "vitest";
import { queryKey } from "./query-key";

describe("queryKey", () => {
  it("returns a single-element key when no params are given", () => {
    expect(queryKey("space.roomy.space.getSpaces")).toEqual([
      "space.roomy.space.getSpaces",
    ]);
  });

  it("returns a single-element key when params are empty", () => {
    expect(queryKey("space.roomy.space.getSpaces", {})).toEqual([
      "space.roomy.space.getSpaces",
    ]);
  });

  it("places the nsid as the first element", () => {
    const key = queryKey("space.roomy.room.getMessages", { roomId: "abc" });
    expect(key[0]).toBe("space.roomy.room.getMessages");
  });

  it("is deterministic — same input yields structurally equal output", () => {
    const a = queryKey("nsid.test", { foo: 1, bar: "x" });
    const b = queryKey("nsid.test", { foo: 1, bar: "x" });
    expect(a).toEqual(b);
  });

  it("ignores param insertion order", () => {
    const a = queryKey("nsid.test", { foo: 1, bar: "x", baz: true });
    const b = queryKey("nsid.test", { baz: true, foo: 1, bar: "x" });
    const c = queryKey("nsid.test", { bar: "x", baz: true, foo: 1 });
    expect(a).toEqual(b);
    expect(a).toEqual(c);
  });

  it("alphabetises param keys in the emitted object", () => {
    const key = queryKey("nsid.test", { zebra: 1, apple: 2, mango: 3 });
    expect(Object.keys(key[1] as Record<string, unknown>)).toEqual([
      "apple",
      "mango",
      "zebra",
    ]);
  });

  it("preserves param values verbatim", () => {
    const params = {
      roomId: "01H...",
      limit: 100,
      cursor: null,
      includeDeleted: false,
    };
    const key = queryKey("space.roomy.room.getMessages", params);
    expect(key[1]).toEqual({
      cursor: null,
      includeDeleted: false,
      limit: 100,
      roomId: "01H...",
    });
  });

  it("does not mutate the caller's params object", () => {
    const params = { z: 1, a: 2 };
    const snapshotKeys = Object.keys(params);
    queryKey("nsid.test", params);
    expect(Object.keys(params)).toEqual(snapshotKeys);
  });

  it("produces a length-2 array when params are provided", () => {
    expect(queryKey("nsid.test", { x: 1 })).toHaveLength(2);
  });
});
