#!/usr/bin/env tsx
/**
 * Test script for debugging Discord channel deletion.
 *
 * Usage:
 *   tsx scripts/test-delete-channel.ts list          # List all Roomy-synced channels
 *   tsx scripts/test-delete-channel.ts delete <id>    # Delete a specific channel by ID
 *   tsx scripts/test-delete-channel.ts test-first    # Test deleting the first Roomy-synced channel
 *
 * Environment variables required:
 *   TEST_GUILD_ID - Discord guild ID to test with
 *   DISCORD_TOKEN - Discord bot token
 */

import "dotenv/config";
import { createBot } from "@discordeno/bot";
import { isRoomySyncedChannel } from "../src/utils/discord-topic.js";

const desiredProperties = {
  message: {
    id: true,
    guildId: true,
    content: true,
    channelId: true,
    author: true,
    webhookId: true,
    timestamp: true,
    editedTimestamp: true,
    attachments: true,
    messageReference: true,
    type: true,
  },
  guild: {
    id: true,
    channels: true,
  },
  channel: {
    id: true,
    lastMessageId: true,
    name: true,
    type: true,
    guildId: true,
    parentId: true,
    topic: true,
  },
  user: {
    username: true,
    avatar: true,
    id: true,
    discriminator: true,
  },
  webhook: {
    id: true,
    token: true,
  },
  interaction: {
    id: true,
    type: true,
    data: true,
    token: true,
    guildId: true,
    authorizingIntegrationOwners: true,
  },
  attachment: {
    id: true,
    filename: true,
    contentType: true,
    size: true,
    url: true,
    proxyUrl: true,
    width: true,
    height: true,
  },
  emoji: {
    id: true,
    name: true,
  },
  messageReference: {
    messageId: true,
    channelId: true,
    guildId: true,
  },
};

type DiscordBot = typeof createBot extends (...args: any[]) => Promise<infer T> ? T : never;

type Channel = {
  id: string;
  name: string;
  type: number;
  topic?: string | null;
  parentId?: string | null;
};

function isTextChannel(channel: { type?: number }): boolean {
  // 0 = GUILD_TEXT, 5 = GUILD_NEWS
  return channel.type === 0 || channel.type === 5;
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    console.error("Usage: tsx scripts/test-delete-channel.ts <list|delete|test-first>");
    process.exit(1);
  }

  const testGuildId = process.env.TEST_GUILD_ID;
  if (!testGuildId) {
    console.error("TEST_GUILD_ID environment variable not set");
    process.exit(1);
  }

  const discordToken = process.env.DISCORD_TOKEN;
  if (!discordToken) {
    console.error("DISCORD_TOKEN environment variable not set");
    process.exit(1);
  }

  console.log("Creating bot...");
  const bot = await createBot({
    token: discordToken,
    desiredProperties,
  });

  console.log(`Fetching channels for guild ${testGuildId}...`);
  const channelsArray = await bot.rest.getChannels(testGuildId);

  if (command === "list") {
    console.log("\n=== All Channels ===");
    let roomySyncedCount = 0;
    for (const channel of channelsArray) {
      const isText = isTextChannel(channel);
      const isSynced = isRoomySyncedChannel(channel.topic ?? null);

      if (isSynced) {
        roomySyncedCount++;
      }

      console.log({
        id: channel.id,
        name: channel.name,
        type: channel.type,
        isText,
        isRoomySynced: isSynced,
        topic: channel.topic ?? null,
      });
    }
    console.log(`\nTotal channels: ${channelsArray.length}`);
    console.log(`Roomy-synced channels: ${roomySyncedCount}`);
  } else if (command === "delete") {
    const channelId = args[1];
    if (!channelId) {
      console.error("Usage: tsx scripts/test-delete-channel.ts delete <channel-id>");
      process.exit(1);
    }

    // Verify channel exists
    const channel = channelsArray.find((c: Channel) => c.id === channelId);
    if (!channel) {
      console.error(`Channel ${channelId} not found in guild`);
      process.exit(1);
    }

    console.log(`Deleting channel:`, {
      id: channelId,
      name: channel.name,
      topic: channel.topic,
    });

    try {
      // First, try fetching the channel directly to verify it exists
      console.log(`Fetching channel ${channelId} directly...`);
      const fetched = await bot.rest.getChannel(BigInt(channelId));
      console.log("Fetched channel:", {
        id: fetched.id.toString(),
        name: fetched.name,
        type: fetched.type,
      });

      // Now try to delete it
      console.log(`Deleting channel ${channelId}...`);
      await bot.rest.deleteChannel(BigInt(channelId));
      console.log("Successfully deleted channel!");
    } catch (error) {
      console.error("Error deleting channel:", error);

      if (error instanceof Error) {
        console.error("Error message:", error.message);
        console.error("Error name:", error.name);
      }

      // Try to check if it's a Discord API error
      const anyError = error as any;
      if (anyError.code) {
        console.error("Discord error code:", anyError.code);
      }
      if (anyError.errors) {
        console.error("Discord errors:", JSON.stringify(anyError.errors, null, 2));
      }
      if (anyError.cause) {
        console.error("Cause:", anyError.cause);
      }
      process.exit(1);
    }
  } else if (command === "test-first") {
    // Find and delete the first Roomy-synced channel
    let firstChannel: Channel | null = null;
    for (const channel of channelsArray) {
      if (isTextChannel(channel) && isRoomySyncedChannel(channel.topic ?? null)) {
        firstChannel = channel;
        console.log(`Found first Roomy-synced channel:`, {
          id: channel.id,
          name: channel.name,
          topic: channel.topic,
        });
        break;
      }
    }

    if (!firstChannel) {
      console.error("No Roomy-synced channels found");
      process.exit(1);
    }

    console.log(`Deleting channel ${firstChannel.id}...`);

    try {
      await bot.rest.deleteChannel(BigInt(firstChannel.id));
      console.log("Successfully deleted channel!");

      // Verify deletion
      console.log("Verifying deletion...");
      try {
        await bot.rest.getChannel(BigInt(firstChannel.id));
        console.error("ERROR: Channel still exists after deletion!");
        process.exit(1);
      } catch (verifyError) {
        const anyVerifyError = verifyError as any;
        if (anyVerifyError.cause?.body?.includes("Unknown Channel")) {
          console.log("Verification successful: channel returns 10003 (Unknown Channel)");
        } else {
          console.error("Unexpected verification error:", verifyError);
        }
      }
    } catch (error) {
      console.error("Error deleting channel:", error);

      if (error instanceof Error) {
        console.error("Error message:", error.message);
        console.error("Error name:", error.name);
      }

      const anyError = error as any;
      if (anyError.code) {
        console.error("Discord error code:", anyError.code);
      }
      if (anyError.errors) {
        console.error("Discord errors:", JSON.stringify(anyError.errors, null, 2));
      }
      if (anyError.cause) {
        console.error("Cause:", anyError.cause);
      }
      process.exit(1);
    }
  } else {
    console.error(`Unknown command: ${command}`);
    console.error("Usage: tsx scripts/test-delete-channel.ts <list|delete|test-first>");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Unhandled error:", error);
  process.exit(1);
});
