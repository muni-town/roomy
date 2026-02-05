/**
 * Tests for Discord reaction operations.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DiscordBot } from "../../src/discord/types.js";
import {
  addReaction,
  removeReaction,
  removeAllReactions,
  clearAllReactions,
} from "../../src/discord/operations/reaction.js";

// Mock DiscordBot
const mockHelpers = {
  addReaction: vi.fn(),
  deleteReaction: vi.fn(),
  removeReactionEmoji: vi.fn(),
  deleteAllReactions: vi.fn(),
};

const mockBot = {
  helpers: mockHelpers,
} as unknown as DiscordBot;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("addReaction", () => {
  it("adds a reaction to a message", async () => {
    mockHelpers.addReaction.mockResolvedValue(undefined);

    const result = await addReaction(mockBot, {
      channelId: 123456789n,
      messageId: 987654321n,
      emoji: "👍",
    });

    expect(result).toEqual({ success: true });
    expect(mockHelpers.addReaction).toHaveBeenCalledTimes(1);
    expect(mockHelpers.addReaction).toHaveBeenCalledWith(
      123456789n,
      987654321n,
      "👍",
    );
  });

  it("adds a custom emoji reaction", async () => {
    mockHelpers.addReaction.mockResolvedValue(undefined);

    await addReaction(mockBot, {
      channelId: 123456789n,
      messageId: 987654321n,
      emoji: "custom_emoji_name:123456789",
    });

    expect(mockHelpers.addReaction).toHaveBeenCalledWith(
      123456789n,
      987654321n,
      "custom_emoji_name:123456789",
    );
  });
});

describe("removeReaction", () => {
  it("removes bot's own reaction", async () => {
    mockHelpers.deleteReaction.mockResolvedValue(undefined);

    const result = await removeReaction(mockBot, {
      channelId: 123456789n,
      messageId: 987654321n,
      emoji: "👍",
    });

    expect(result).toEqual({ success: true });
    expect(mockHelpers.deleteReaction).toHaveBeenCalledTimes(1);
    expect(mockHelpers.deleteReaction).toHaveBeenCalledWith(
      123456789n,
      987654321n,
      "👍",
    );
  });

  it("removes a specific user's reaction", async () => {
    mockHelpers.removeReactionEmoji.mockResolvedValue(undefined);

    const result = await removeReaction(mockBot, {
      channelId: 123456789n,
      messageId: 987654321n,
      emoji: "👍",
      userId: 111222333n,
    });

    expect(result).toEqual({ success: true });
    expect(mockHelpers.removeReactionEmoji).toHaveBeenCalledTimes(1);
    expect(mockHelpers.removeReactionEmoji).toHaveBeenCalledWith(
      123456789n,
      987654321n,
      "👍",
      111222333n,
    );
  });
});

describe("removeAllReactions", () => {
  it("removes all reactions for an emoji", async () => {
    mockHelpers.removeReactionEmoji.mockResolvedValue(undefined);

    const result = await removeAllReactions(mockBot, {
      channelId: 123456789n,
      messageId: 987654321n,
      emoji: "👍",
    });

    expect(result).toEqual({ success: true });
    expect(mockHelpers.removeReactionEmoji).toHaveBeenCalledTimes(1);
    expect(mockHelpers.removeReactionEmoji).toHaveBeenCalledWith(
      123456789n,
      987654321n,
      "👍",
    );
  });
});

describe("clearAllReactions", () => {
  it("clears all reactions from a message", async () => {
    mockHelpers.deleteAllReactions.mockResolvedValue(undefined);

    const result = await clearAllReactions(mockBot, {
      channelId: 123456789n,
      messageId: 987654321n,
    });

    expect(result).toEqual({ success: true });
    expect(mockHelpers.deleteAllReactions).toHaveBeenCalledTimes(1);
    expect(mockHelpers.deleteAllReactions).toHaveBeenCalledWith(
      123456789n,
      987654321n,
    );
  });
});
