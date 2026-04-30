/**
 * Tests for room utility functions.
 * These functions are pure and deterministic, making them easy to test.
 */

import { describe, it, expect } from "vitest";
import { getRoomKey } from "../../src/utils/room";

describe("getRoomKey", () => {
  it("should add room: prefix to string IDs", () => {
    expect(getRoomKey("123456789")).toEqual("room:123456789");
  });

  it("should add room: prefix to bigint IDs", () => {
    expect(getRoomKey(123456789n)).toEqual("room:123456789");
  });

  it("should handle numeric string IDs", () => {
    expect(getRoomKey("987654321")).toEqual("room:987654321");
  });

  it("should handle large bigint IDs", () => {
    expect(getRoomKey(BigInt("123456789012345678"))).toEqual("room:123456789012345678");
  });

  it("should be deterministic", () => {
    const key1 = getRoomKey(123n);
    const key2 = getRoomKey(123n);
    expect(key1).toEqual(key2);
  });

  it("should produce different keys for different IDs", () => {
    const key1 = getRoomKey(111n);
    const key2 = getRoomKey(222n);
    expect(key1).not.toEqual(key2);
  });

  it("should handle string bigint representation", () => {
    expect(getRoomKey("123")).toEqual(getRoomKey(123n));
  });
});
