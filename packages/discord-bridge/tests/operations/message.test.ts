/**
 * Tests for Discord message operations.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DiscordBot } from "../../src/discord/types.js";
import {
  createWebhookMessage,
  createBotMessage,
  editMessage,
  deleteMessage,
  fetchMessage,
} from "../../src/discord/operations/message.js";

// Mock DiscordBot
const mockHelpers = {
  executeWebhook: vi.fn(),
  sendMessage: vi.fn(),
  editMessage: vi.fn(),
  deleteMessage: vi.fn(),
  getMessage: vi.fn(),
};

const mockBot = {
  helpers: mockHelpers,
} as unknown as DiscordBot;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createWebhookMessage", () => {
  it("creates a message via webhook", async () => {
    mockHelpers.executeWebhook.mockResolvedValue({
      id: 123n,
    });

    const result = await createWebhookMessage(mockBot, {
      channelId: 123456789n,
      webhookId: 987654321n,
      webhookToken: "abc123",
      content: "Hello from webhook!",
    });

    expect(result.id).toBe(123n);
    expect(mockHelpers.executeWebhook).toHaveBeenCalledTimes(1);
    expect(mockHelpers.executeWebhook).toHaveBeenCalledWith(
      987654321n,
      "abc123",
      expect.objectContaining({
        content: "Hello from webhook!",
      }),
    );
  });

  it("creates a message with username override", async () => {
    mockHelpers.executeWebhook.mockResolvedValue({
      id: 123n,
    });

    await createWebhookMessage(mockBot, {
      channelId: 123456789n,
      webhookId: 987654321n,
      webhookToken: "abc123",
      content: "Hello",
      username: "Custom Bot",
    });

    expect(mockHelpers.executeWebhook).toHaveBeenCalledWith(
      987654321n,
      "abc123",
      expect.objectContaining({
        username: "Custom Bot",
      }),
    );
  });

  it("creates a message with avatar URL", async () => {
    mockHelpers.executeWebhook.mockResolvedValue({
      id: 123n,
    });

    await createWebhookMessage(mockBot, {
      channelId: 123456789n,
      webhookId: 987654321n,
      webhookToken: "abc123",
      content: "Hello",
      avatarUrl: "https://example.com/avatar.png",
    });

    expect(mockHelpers.executeWebhook).toHaveBeenCalledWith(
      987654321n,
      "abc123",
      expect.objectContaining({
        avatarUrl: "https://example.com/avatar.png",
      }),
    );
  });

  it("creates a message with nonce for idempotency", async () => {
    mockHelpers.executeWebhook.mockResolvedValue({
      id: 123n,
    });

    await createWebhookMessage(mockBot, {
      channelId: 123456789n,
      webhookId: 987654321n,
      webhookToken: "abc123",
      content: "Hello",
      nonce: "unique-nonce-123",
    });

    expect(mockHelpers.executeWebhook).toHaveBeenCalledWith(
      987654321n,
      "abc123",
      expect.objectContaining({
        nonce: "unique-nonce-123",
      }),
    );
  });

  it("throws when webhook returns no message ID", async () => {
    mockHelpers.executeWebhook.mockResolvedValue(null);

    await expect(
      createWebhookMessage(mockBot, {
        channelId: 123456789n,
        webhookId: 987654321n,
        webhookToken: "abc123",
        content: "Hello",
      }),
    ).rejects.toThrow("Webhook execution did not return a message ID");
  });
});

describe("createBotMessage", () => {
  it("creates a message as the bot", async () => {
    mockHelpers.sendMessage.mockResolvedValue({
      id: 456n,
    });

    const result = await createBotMessage(mockBot, {
      channelId: 123456789n,
      content: "Hello from bot!",
    });

    expect(result.id).toBe(456n);
    expect(mockHelpers.sendMessage).toHaveBeenCalledTimes(1);
    expect(mockHelpers.sendMessage).toHaveBeenCalledWith(123456789n, {
      content: "Hello from bot!",
    });
  });
});

describe("editMessage", () => {
  it("edits a message", async () => {
    mockHelpers.editMessage.mockResolvedValue({
      id: 789n,
    });

    const result = await editMessage(mockBot, {
      channelId: 123456789n,
      messageId: 987654321n,
      content: "Edited message",
    });

    expect(result.id).toBe(789n);
    expect(mockHelpers.editMessage).toHaveBeenCalledTimes(1);
    expect(mockHelpers.editMessage).toHaveBeenCalledWith(
      123456789n,
      987654321n,
      { content: "Edited message" },
    );
  });
});

describe("deleteMessage", () => {
  it("deletes a message", async () => {
    mockHelpers.deleteMessage.mockResolvedValue(undefined);

    const result = await deleteMessage(mockBot, {
      channelId: 123456789n,
      messageId: 987654321n,
    });

    expect(result).toEqual({ success: true });
    expect(mockHelpers.deleteMessage).toHaveBeenCalledTimes(1);
    expect(mockHelpers.deleteMessage).toHaveBeenCalledWith(
      123456789n,
      987654321n,
    );
  });
});

describe("fetchMessage", () => {
  it("fetches a message", async () => {
    mockHelpers.getMessage.mockResolvedValue({
      id: 999n,
      content: "Fetched message",
      author: {
        id: 111n,
        username: "testuser", // Added
        discriminator: "1234", // Added
        avatar: null,
      },
      username: "testuser",
      discriminator: "1234",
      timestamp: new Date("2024-01-01T00:00:00Z"),
      editedTimestamp: null,
      attachments: [],
      webhookId: undefined,
      type: 0,
      messageReference: null,
    });

    const result = await fetchMessage(mockBot, {
      channelId: 123456789n,
      messageId: 987654321n,
    });

    expect(result.id).toBe(999n);
    expect(result.content).toBe("Fetched message");
    expect(result.author).toEqual({
      id: 111n,
      username: "testuser",
      discriminator: "1234",
      avatar: null, // Discord API returns null when avatar is not set
    });
    expect(result.timestamp).toBe(1704067200000); // 2024-01-01
    expect(mockHelpers.getMessage).toHaveBeenCalledTimes(1);
  });

  it("fetches a message with attachments", async () => {
    mockHelpers.getMessage.mockResolvedValue({
      id: 999n,
      content: "Message with attachment",
      author: {
        id: 111n,
        username: "testuser",
        discriminator: "1234",
        avatar: null,
      },
      username: "testuser",
      discriminator: "1234",
      timestamp: new Date("2024-01-01T00:00:00Z"),
      editedTimestamp: null,
      attachments: [
        {
          id: 555n,
          filename: "image.png",
          contentType: "image/png",
          size: 12345,
          url: "https://example.com/image.png",
          width: 1920,
          height: 1080,
        },
      ],
      webhookId: undefined,
      type: 0,
      messageReference: null,
    });

    const result = await fetchMessage(mockBot, {
      channelId: 123456789n,
      messageId: 987654321n,
    });

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]).toEqual({
      id: 555n,
      filename: "image.png",
      contentType: "image/png",
      size: 12345,
      url: "https://example.com/image.png",
      width: 1920,
      height: 1080,
    });
  });

  it("fetches a message with message reference", async () => {
    mockHelpers.getMessage.mockResolvedValue({
      id: 999n,
      content: "Reply message",
      author: {
        id: 111n,
        username: "testuser",
        discriminator: "1234",
        avatar: null,
      },
      username: "testuser",
      discriminator: "1234",
      timestamp: new Date("2024-01-01T00:00:00Z"),
      editedTimestamp: null,
      attachments: [],
      webhookId: undefined,
      type: 0,
      messageReference: {
        messageId: 888n,
        channelId: 123456789n,
        guildId: 123456789n,
      },
    });

    const result = await fetchMessage(mockBot, {
      channelId: 123456789n,
      messageId: 987654321n,
    });

    expect(result.messageReference).toEqual({
      messageId: 888n,
      channelId: 123456789n,
    });
  });
});
