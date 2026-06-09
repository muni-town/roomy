/**
 * Unit tests for mention-resolver.ts
 *
 * Covers: Discord mention syntax → clean Markdown transformations.
 * All mention resolution scenarios (user, channel, custom emoji).
 */

import { describe, expect, test } from "bun:test";
import { resolveMentions, type UserMention, type MentionContext } from "../mention-resolver.ts";

function ctx(overrides: Partial<MentionContext> = {}): MentionContext {
  return {
    channelNames: new Map(),
    roomyRoomIds: new Map(),
    ...overrides,
  };
}

describe("resolveMentions", () => {
  test("returns empty string for empty input", () => {
    expect(resolveMentions("", [], ctx())).toBe("");
    expect(resolveMentions("", undefined, ctx())).toBe("");
  });

  test("passes through content without mentions", () => {
    const result = resolveMentions("Hello, world!", [], ctx());
    expect(result).toBe("Hello, world!");
  });

  describe("user mentions", () => {
    test("replaces <@12345> with [@DisplayName]()", () => {
      const mentions: UserMention[] = [
        { id: BigInt("12345"), username: "testuser", globalName: "Test User" },
      ];
      const result = resolveMentions("Hey <@12345>!", mentions, ctx());
      expect(result).toBe("Hey [@Test User]()!");
    });

    test("falls back to username when globalName is absent", () => {
      const mentions: UserMention[] = [
        { id: BigInt("12345"), username: "testuser", globalName: null },
      ];
      const result = resolveMentions("Hey <@12345>!", mentions, ctx());
      expect(result).toBe("Hey [@testuser]()!");
    });

    test("handles <@!12345> (nickname format)", () => {
      const mentions: UserMention[] = [
        { id: BigInt("12345"), username: "nickuser", globalName: "Nick User" },
      ];
      const result = resolveMentions("<@!12345>", mentions, ctx());
      expect(result).toBe("[@Nick User]()");
    });

    test("escapes Markdown characters in display names", () => {
      const mentions: UserMention[] = [
        { id: BigInt("12345"), username: "test", globalName: "Test [User]*_~" },
      ];
      const result = resolveMentions("<@12345>", mentions, ctx());
      expect(result).toBe("[@Test \\[User\\]\\*\\_\\~]()");
    });

    test("uses snowflake when user not in mentions array", () => {
      const result = resolveMentions("<@99999>", [], ctx());
      expect(result).toBe("[@99999]()");
    });
  });

  describe("channel mentions", () => {
    test("replaces <#12345> with [#name](roomyUlid)", () => {
      const channelNames = new Map([["12345", "general"]]);
      const roomyRoomIds = new Map([["12345", "01JQROOMY1"]]);
      const result = resolveMentions("Check <#12345>", [], ctx({ channelNames, roomyRoomIds }));
      expect(result).toBe("Check [#general](01JQROOMY1)");
    });

    test("uses empty link when roomyRoomId not available", () => {
      const channelNames = new Map([["12345", "general"]]);
      const result = resolveMentions("Check <#12345>", [], ctx({ channelNames }));
      expect(result).toBe("Check [#general]()");
    });

    test("uses snowflake when channel name not in map", () => {
      const result = resolveMentions("<#99999>", [], ctx());
      expect(result).toBe("[#99999]()");
    });

    test("escapes Markdown characters in channel names", () => {
      const channelNames = new Map([["12345", "[dev] testing*"]]);
      const result = resolveMentions("<#12345>", [], ctx({ channelNames }));
      expect(result).toBe("[#\\[dev\\] testing\\*]()");
    });
  });

  describe("custom emoji", () => {
    test("strips static custom emoji <:name:id>", () => {
      const result = resolveMentions("Look <:blob:99999>!", [], ctx());
      expect(result).toBe("Look !");
    });

    test("strips animated custom emoji <a:name:id>", () => {
      const result = resolveMentions("Look <a:party:88888>!", [], ctx());
      expect(result).toBe("Look !");
    });

    test("strips multiple emoji in same message", () => {
      const result = resolveMentions(
        "<:a:111> <:b:222> <a:c:333>",
        [],
        ctx(),
      );
      expect(result).toBe("  ");
    });

    test("preserves Unicode emoji", () => {
      const result = resolveMentions("Hello 👍 world!", [], ctx());
      expect(result).toBe("Hello 👍 world!");
    });
  });

  describe("combined scenarios", () => {
    test("handles mixed user, channel, and emoji mentions", () => {
      const mentions: UserMention[] = [
        { id: BigInt("111"), username: "alice", globalName: "Alice" },
        { id: BigInt("222"), username: "bob", globalName: null },
      ];
      const channelNames = new Map([["333", "general"]]);
      const roomyRoomIds = new Map([["333", "01JQROOMY2"]]);

      const result = resolveMentions(
        "<@111> and <@!222> check <#333> <:wave:444>",
        mentions,
        ctx({ channelNames, roomyRoomIds }),
      );

      expect(result).toBe("[@Alice]() and [@bob]() check [#general](01JQROOMY2) ");
    });

    test("handles large content without crashing", () => {
      const largeContent = "A".repeat(5000) + " <@12345> " + "B".repeat(5000);
      const mentions: UserMention[] = [
        { id: BigInt("12345"), username: "big", globalName: "Big User" },
      ];
      const result = resolveMentions(largeContent, mentions, ctx());
      expect(result).toContain("[@Big User]()");
      expect(result.length).toBe(largeContent.length - "<@12345>".length + "[@Big User]()".length);
    });
  });
});