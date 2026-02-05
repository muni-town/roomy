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
  deleteOwnReaction: vi.fn(),
  deleteUserReaction: vi.fn(),
  deleteReactionsEmoji: vi.fn(),
  deleteReactionsAll: vi.fn(),
};

const mockBot = {
  id: 123456789n,
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
    mockHelpers.deleteOwnReaction.mockResolvedValue(undefined);

    const result = await removeReaction(mockBot, {
      channelId: 123456789n,
      messageId: 987654321n,
      emoji: "👍",
    });

    expect(result).toEqual({ success: true });
    expect(mockHelpers.deleteOwnReaction).toHaveBeenCalledTimes(1);
    expect(mockHelpers.deleteOwnReaction).toHaveBeenCalledWith(
      123456789n,
      987654321n,
      "👍",
    );
  });

  it("removes a specific user's reaction", async () => {
    mockHelpers.deleteUserReaction.mockResolvedValue(undefined);

    const result = await removeReaction(mockBot, {
      channelId: 123456789n,
      messageId: 987654321n,
      emoji: "👍",
      userId: 111222333n,
    });

    expect(result).toEqual({ success: true });
    expect(mockHelpers.deleteUserReaction).toHaveBeenCalledTimes(1);
    expect(mockHelpers.deleteUserReaction).toHaveBeenCalledWith(
      123456789n,
      987654321n,
      "👍",
      "111222333",
    );
  });
});

describe("removeAllReactions", () => {
  it("removes all reactions for an emoji", async () => {
    mockHelpers.deleteReactionsEmoji.mockResolvedValue(undefined);

    const result = await removeAllReactions(mockBot, {
      channelId: 123456789n,
      messageId: 987654321n,
      emoji: "👍",
    });

    expect(result).toEqual({ success: true });
    expect(mockHelpers.deleteReactionsEmoji).toHaveBeenCalledTimes(1);
    expect(mockHelpers.deleteReactionsEmoji).toHaveBeenCalledWith(
      123456789n,
      987654321n,
      "👍",
    );
  });
});

describe("clearAllReactions", () => {
  it("clears all reactions from a message", async () => {
    mockHelpers.deleteReactionsAll.mockResolvedValue(undefined);

    const result = await clearAllReactions(mockBot, {
      channelId: 123456789n,
      messageId: 987654321n,
    });

    expect(result).toEqual({ success: true });
    expect(mockHelpers.deleteReactionsAll).toHaveBeenCalledTimes(1);
    expect(mockHelpers.deleteReactionsAll).toHaveBeenCalledWith(
      123456789n,
      987654321n,
    );
  });
});
