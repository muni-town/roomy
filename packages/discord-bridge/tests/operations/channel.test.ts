/**
 * Tests for Discord channel operations.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DiscordBot } from "../../src/discord/types.js";
import {
  createChannel,
  createThread,
  fetchChannel,
} from "../../src/discord/operations/channel.js";

// Mock DiscordBot
const mockHelpers = {
  createChannel: vi.fn(),
  startThreadWithMessage: vi.fn(),
  startThreadWithoutMessage: vi.fn(),
  getChannel: vi.fn(),
};

const mockBot = {
  helpers: mockHelpers,
} as unknown as DiscordBot;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createChannel", () => {
  it("creates a text channel", async () => {
    mockHelpers.createChannel.mockResolvedValue({
      id: 123n,
    });

    const result = await createChannel(mockBot, {
      guildId: 123456789n,
      name: "new-channel",
      type: 0, // GUILD_TEXT
    });

    expect(result.id).toBe(123n);
    expect(mockHelpers.createChannel).toHaveBeenCalledTimes(1);
    expect(mockHelpers.createChannel).toHaveBeenCalledWith(
      123456789n,
      expect.objectContaining({
        name: "new-channel",
        type: 0,
      }),
    );
  });

  it("creates a channel with parent category", async () => {
    mockHelpers.createChannel.mockResolvedValue({
      id: 456n,
    });

    await createChannel(mockBot, {
      guildId: 123456789n,
      name: "new-channel",
      type: 0,
      parentId: 987654321n,
    });

    expect(mockHelpers.createChannel).toHaveBeenCalledWith(
      123456789n,
      expect.objectContaining({
        parentId: "987654321",
      }),
    );
  });

  it("creates a channel with topic", async () => {
    mockHelpers.createChannel.mockResolvedValue({
      id: 789n,
    });

    await createChannel(mockBot, {
      guildId: 123456789n,
      name: "new-channel",
      type: 0,
      topic: "Channel description",
    });

    expect(mockHelpers.createChannel).toHaveBeenCalledWith(
      123456789n,
      expect.objectContaining({
        topic: "Channel description",
      }),
    );
  });
});

describe("createThread", () => {
  it("creates a thread from a message", async () => {
    mockHelpers.startThreadWithMessage.mockResolvedValue({
      id: 111n,
    });

    const result = await createThread(mockBot, {
      channelId: 123456789n,
      name: "Thread name",
      messageId: 987654321n,
    });

    expect(result.id).toBe(111n);
    expect(mockHelpers.startThreadWithMessage).toHaveBeenCalledTimes(1);
    expect(mockHelpers.startThreadWithMessage).toHaveBeenCalledWith(
      123456789n,
      987654321n,
      expect.objectContaining({
        name: "Thread name",
      }),
    );
  });

  it("creates a thread without a message", async () => {
    mockHelpers.startThreadWithoutMessage.mockResolvedValue({
      id: 222n,
    });

    const result = await createThread(mockBot, {
      channelId: 123456789n,
      name: "Thread name",
    });

    expect(result.id).toBe(222n);
    expect(mockHelpers.startThreadWithoutMessage).toHaveBeenCalledTimes(1);
    expect(mockHelpers.startThreadWithoutMessage).toHaveBeenCalledWith(
      123456789n,
      expect.objectContaining({
        name: "Thread name",
      }),
    );
  });
});

describe("fetchChannel", () => {
  it("fetches a channel", async () => {
    mockHelpers.getChannel.mockResolvedValue({
      id: 333n,
      name: "channel-name",
      type: 0,
      guildId: 123456789n,
      parentId: null,
      lastMessageId: 999n,
    });

    const result = await fetchChannel(mockBot, {
      channelId: 123456789n,
    });

    expect(result.id).toBe(333n);
    expect(result.name).toBe("channel-name");
    expect(result.type).toBe(0);
    expect(result.guildId).toBe(123456789n);
    expect(result.parentId).toBeNull();
    expect(result.lastMessageId).toBe(999n);
    expect(mockHelpers.getChannel).toHaveBeenCalledTimes(1);
  });

  it("fetches a channel with parent", async () => {
    mockHelpers.getChannel.mockResolvedValue({
      id: 444n,
      name: "child-channel",
      type: 0,
      guildId: 123456789n,
      parentId: 555n,
      lastMessageId: null,
    });

    const result = await fetchChannel(mockBot, {
      channelId: 123456789n,
    });

    expect(result.parentId).toBe(555n);
  });
});
