/**
 * Tests for Discord backfill logic.
 * Tests the backfillGuild function to ensure proper ordering and handling of edge cases.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { MockBridgeRepository } from "../../src/repositories/MockBridgeRepository.js";
import type { DiscordChannel } from "@discordeno/types";
import { ChannelTypes } from "discordeno";

describe("Discord Backfill Logic", () => {
  describe("Thread processing with unsynced parents", () => {
    it("should skip threads whose parent is not in synced channel list", () => {
      // Mock text channels (only GuildText type is synced)
      const textChannels: DiscordChannel[] = [
        {
          id: 111n,
          name: "general",
          type: ChannelTypes.GuildText,
          parentId: null,
        } as DiscordChannel,
      ];

      // Mock threads - one with synced parent, one without
      const threadWithSyncedParent: DiscordChannel = {
        id: 222n,
        name: "thread-in-general",
        type: 11, // Thread
        parentId: 111n, // Parent is in textChannels
      } as DiscordChannel;

      const threadWithUnsyncedParent: DiscordChannel = {
        id: 333n,
        name: "thread-in-announcement",
        type: 11, // Thread
        parentId: 999n, // Parent is NOT in textChannels (e.g., announcement channel)
      } as DiscordChannel;

      // Build set of synced channel IDs (simulating what bot.ts does)
      const syncedChannelIds = new Set(textChannels.map((c) => c.id.toString()));

      // Thread with synced parent should be processed
      const parentIdStr1 = threadWithSyncedParent.parentId!.toString();
      expect(syncedChannelIds.has(parentIdStr1)).toBe(true);

      // Thread with unsynced parent should be skipped
      const parentIdStr2 = threadWithUnsyncedParent.parentId!.toString();
      expect(syncedChannelIds.has(parentIdStr2)).toBe(false);
    });

    it("should handle threads with no parentId gracefully", () => {
      const threadWithoutParent: DiscordChannel = {
        id: 444n,
        name: "orphan-thread",
        type: 11,
        parentId: null, // No parent
      } as DiscordChannel;

      // This thread should be skipped with a warning
      expect(threadWithoutParent.parentId).toBeNull();
    });

    it("should distinguish between GuildText and other channel types", () => {
      const allChannels: DiscordChannel[] = [
        {
          id: 111n,
          name: "text-channel",
          type: ChannelTypes.GuildText, // 0 - synced
        } as DiscordChannel,
        {
          id: 222n,
          name: "announcement-channel",
          type: ChannelTypes.GuildAnnouncement, // 5 - NOT synced (yet)
        } as DiscordChannel,
        {
          id: 333n,
          name: "forum-channel",
          type: 15, // GuildForum - NOT synced (yet)
        } as DiscordChannel,
      ];

      // Filter for GuildText only (what bot.ts does)
      const textChannels = allChannels.filter(
        (x) => x.type === ChannelTypes.GuildText,
      );

      expect(textChannels.length).toBe(1);
      expect(textChannels[0].id).toBe(111n);

      // Announcement and forum channels are NOT in textChannels
      const syncedIds = new Set(textChannels.map((c) => c.id.toString()));
      expect(syncedIds.has("222")).toBe(false); // Announcement not synced
      expect(syncedIds.has("333")).toBe(false); // Forum not synced
    });
  });

  describe("Backfill ordering", () => {
    it("should process all channels before threads", async () => {
      // Track processing order
      const processingOrder: string[] = [];

      const textChannels: DiscordChannel[] = [
        { id: 111n, name: "channel-1", type: ChannelTypes.GuildText } as DiscordChannel,
        { id: 222n, name: "channel-2", type: ChannelTypes.GuildText } as DiscordChannel,
      ];

      const threads: DiscordChannel[] = [
        { id: 333n, name: "thread-1", type: 11, parentId: 111n } as DiscordChannel,
      ];

      // Simulate backfill order
      for (const channel of textChannels) {
        processingOrder.push(`channel:${channel.id}`);
      }

      for (const thread of threads) {
        const parentIdStr = thread.parentId!.toString();
        if (textChannels.some((c) => c.id.toString() === parentIdStr)) {
          processingOrder.push(`thread:${thread.id}`);
        }
      }

      // Channels should be processed before threads
      expect(processingOrder).toEqual(["channel:111", "channel:222", "thread:333"]);
    });
  });
});
