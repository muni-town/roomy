/**
 * Tests for emoji utility functions.
 * These functions are pure and deterministic, making them easy to test.
 */

import { describe, it, expect } from "vitest";
import { emojiToString, reactionKey } from "../../src/utils/emoji";

describe("emojiToString", () => {
  describe("custom emojis", () => {
    it("should format static custom emojis", () => {
      const result = emojiToString({ id: 123456n, name: "nyan" });
      expect(result).toEqual("<:nyan:123456>");
    });

    it("should format animated custom emojis", () => {
      const result = emojiToString({
        id: 123456n,
        name: "nyan",
        animated: true,
      });
      expect(result).toEqual("<a:nyan:123456>");
    });

    it("should handle emojis without names", () => {
      const result = emojiToString({ id: 123456n, name: undefined });
      expect(result).toEqual("<:_:123456>");
    });
  });

  describe("unicode emojis", () => {
    it("should return unicode emoji directly", () => {
      const result = emojiToString({ name: "😀", id: undefined });
      expect(result).toEqual("😀");
    });

    it("should return question mark for missing emoji", () => {
      const result = emojiToString({});
      expect(result).toEqual("❓");
    });

    it("should handle unicode emoji with id: undefined", () => {
      const result = emojiToString({ name: "🎉", id: undefined });
      expect(result).toEqual("🎉");
    });
  });
});

describe("reactionKey", () => {
  it("should generate consistent keys for same reaction", () => {
    const key1 = reactionKey(123n, 456n, { id: 789n, name: "nyan" });
    const key2 = reactionKey(123n, 456n, { id: 789n, name: "nyan" });
    expect(key1).toEqual(key2);
  });

  it("should include custom emoji ID in key", () => {
    const key = reactionKey(123n, 456n, { id: 789n, name: "nyan" });
    expect(key).toEqual("123:456:789");
  });

  it("should include unicode emoji name in key", () => {
    const key = reactionKey(123n, 456n, { name: "😀", id: undefined });
    expect(key).toEqual("123:456:😀");
  });

  it("should generate different keys for different reactions", () => {
    const key1 = reactionKey(123n, 456n, { id: 789n, name: "nyan" });
    const key2 = reactionKey(123n, 456n, { id: 999n, name: "nyan" });
    expect(key1).not.toEqual(key2);
  });

  it("should generate different keys for different users", () => {
    const key1 = reactionKey(123n, 111n, { name: "😀" });
    const key2 = reactionKey(123n, 222n, { name: "😀" });
    expect(key1).not.toEqual(key2);
  });

  it("should generate different keys for different messages", () => {
    const key1 = reactionKey(111n, 456n, { name: "😀" });
    const key2 = reactionKey(222n, 456n, { name: "😀" });
    expect(key1).not.toEqual(key2);
  });

  it("should handle missing emoji name", () => {
    const key = reactionKey(123n, 456n, {});
    expect(key).toEqual("123:456:unknown");
  });

  it("should handle bigint IDs", () => {
    const key = reactionKey(BigInt("123456789"), BigInt("987654321"), {
      name: "😀",
    });
    expect(key).toEqual("123456789:987654321:😀");
  });
});
