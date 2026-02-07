/**
 * Unit tests for backfillDiscordReactions.
 *
 * Uses mocks to verify that reactions are actually synced when found.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { backfillDiscordReactions } from "../../src/discord/backfill.js";
import type { DiscordBot, Emoji } from "@discordeno/bot";
import type { GuildContext } from "../../src/types.js";
import { newUlid, ConnectedSpace } from "@roomy/sdk";

// Mock the ReactionSyncService
vi.mock("../../src/services/ReactionSyncService.js", () => ({
  ReactionSyncService: vi.fn().mockImplementation(() => ({
    syncAddToRoomy: vi.fn().mockResolvedValue("mock-reaction-id"),
  })),
}));

describe("Unit: backfillDiscordReactions", () => {
  let mockBot: DiscordBot;
  let mockCtx: GuildContext;
  let mockConnectedSpace: ConnectedSpace;

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();

    // Create mock bot with helpers
    mockBot = {
      id: 123456789n,
      helpers: {
        getMessages: vi.fn(),
        getReactions: vi.fn(),
      },
    } as unknown as DiscordBot;

    // Create mock guild context
    mockCtx = {
      guildId: 123n,
      spaceId: "did:plc:test",
      syncedIds: {
        getRoomyId: vi.fn().mockResolvedValue("roomy-message-id"),
        register: vi.fn(),
        getDiscordId: vi.fn(),
      },
      syncedReactions: {
        getReaction: vi.fn().mockResolvedValue(null),
        setReaction: vi.fn(),
        deleteReaction: vi.fn(),
      },
      syncedProfiles: {},
      syncedRoomLinks: {},
      syncedSidebarHash: {},
      syncedEdits: {},
      discordMessageHashes: {},
      latestMessagesInChannel: {},
      connectedSpace: null as any,
    } as unknown as GuildContext;

    // Mock ConnectedSpace
    mockConnectedSpace = {
      sendEvent: vi.fn().mockResolvedValue(undefined),
      fetchEvents: vi.fn().mockResolvedValue([]),
    } as unknown as ConnectedSpace;

    mockCtx.connectedSpace = mockConnectedSpace;
  });

  it("should sync reactions when found on messages", async () => {
    const { ReactionSyncService } = await import("../../src/services/ReactionSyncService.js");
    const mockSyncAddToRoomy = vi.fn().mockResolvedValue("reaction-event-id");
    (ReactionSyncService as any).mockImplementation(() => ({
      syncAddToRoomy: mockSyncAddToRoomy,
    }));

    // Mock bot responses
    const mockEmoji: Partial<Emoji> = { name: "👍", id: null };

    // First call to getMessages returns messages with reactions
    (mockBot.helpers.getMessages as any)
      .mockResolvedValueOnce([
        {
          id: 1n,
          content: "Test message",
          reactions: [
            { emoji: mockEmoji, count: 2 },
          ],
        },
      ])
      .mockResolvedValueOnce([]); // Second call returns empty (pagination end)

    // Mock getReactions to return users who reacted
    const mockUsers = [
      { id: 111n, username: "user1" },
      { id: 222n, username: "user2" },
    ];
    (mockBot.helpers.getReactions as any).mockResolvedValue(mockUsers);

    // Run backfill
    await backfillDiscordReactions(mockBot, mockCtx, 12345n);

    // Verify syncAddToRoomy was called for each user
    expect(mockSyncAddToRoomy).toHaveBeenCalledTimes(2);
    expect(mockSyncAddToRoomy).toHaveBeenCalledWith(1n, 12345n, 111n, mockEmoji);
    expect(mockSyncAddToRoomy).toHaveBeenCalledWith(1n, 12345n, 222n, mockEmoji);
  });

  it("should handle custom emojis with id", async () => {
    const { ReactionSyncService } = await import("../../src/services/ReactionSyncService.js");
    const mockSyncAddToRoomy = vi.fn().mockResolvedValue("reaction-event-id");
    (ReactionSyncService as any).mockImplementation(() => ({
      syncAddToRoomy: mockSyncAddToRoomy,
    }));

    // Mock custom emoji
    const mockEmoji: Partial<Emoji> = { name: "pepe", id: 456n };

    (mockBot.helpers.getMessages as any)
      .mockResolvedValueOnce([
        {
          id: 1n,
          reactions: [
            { emoji: mockEmoji, count: 1 },
          ],
        },
      ])
      .mockResolvedValueOnce([]);

    (mockBot.helpers.getReactions as any).mockResolvedValue([
      { id: 333n, username: "user3" },
    ]);

    await backfillDiscordReactions(mockBot, mockCtx, 12345n);

    // Verify getReactions was called with correct emoji format (name:id)
    expect(mockBot.helpers.getReactions).toHaveBeenCalledWith(
      12345n,
      1n,
      "pepe:456",
      expect.anything()
    );

    expect(mockSyncAddToRoomy).toHaveBeenCalledWith(1n, 12345n, 333n, mockEmoji);
  });

  it("should handle pagination of reaction users", async () => {
    const { ReactionSyncService } = await import("../../src/services/ReactionSyncService.js");
    const mockSyncAddToRoomy = vi.fn().mockResolvedValue("reaction-event-id");
    (ReactionSyncService as any).mockImplementation(() => ({
      syncAddToRoomy: mockSyncAddToRoomy,
    }));

    const mockEmoji: Partial<Emoji> = { name: "🎉", id: null };

    (mockBot.helpers.getMessages as any)
      .mockResolvedValueOnce([
        {
          id: 1n,
          reactions: [
            { emoji: mockEmoji, count: 150 }, // More than 100 users
          ],
        },
      ])
      .mockResolvedValueOnce([]);

    // First call returns 100 users (pagination)
    // Second call returns 50 users
    const page1Users = Array.from({ length: 100 }, (_, i) => ({
      id: BigInt(i + 1),
      username: `user${i}`,
    }));
    const page2Users = Array.from({ length: 50 }, (_, i) => ({
      id: BigInt(i + 101),
      username: `user${i + 100}`,
    }));

    (mockBot.helpers.getReactions as any)
      .mockResolvedValueOnce(page1Users)
      .mockResolvedValueOnce(page2Users);

    await backfillDiscordReactions(mockBot, mockCtx, 12345n);

    // Verify syncAddToRoomy was called for all 150 users
    expect(mockSyncAddToRoomy).toHaveBeenCalledTimes(150);
  });

  it("should handle messages with no reactions", async () => {
    const { ReactionSyncService } = await import("../../src/services/ReactionSyncService.js");
    const mockSyncAddToRoomy = vi.fn().mockResolvedValue("reaction-event-id");
    (ReactionSyncService as any).mockImplementation(() => ({
      syncAddToRoomy: mockSyncAddToRoomy,
    }));

    // Mock messages without reactions
    (mockBot.helpers.getMessages as any)
      .mockResolvedValueOnce([
        { id: 1n, content: "No reactions here", reactions: [] },
        { id: 2n, content: "Also no reactions", reactions: undefined },
      ])
      .mockResolvedValueOnce([]);

    await backfillDiscordReactions(mockBot, mockCtx, 12345n);

    // Verify syncAddToRoomy was never called
    expect(mockSyncAddToRoomy).not.toHaveBeenCalled();
    expect(mockBot.helpers.getReactions).not.toHaveBeenCalled();
  });
});
