#!/usr/bin/env tsx
/**
 * Run full cleanup of all Roomy-synced channels.
 */

import "dotenv/config";
import { createBot } from "@discordeno/bot";
import { cleanupRoomySyncedChannels } from "../tests/e2e/helpers/setup.js";

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

async function main() {
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

  console.log(`Running cleanup for guild ${testGuildId}...`);
  const deletedCount = await cleanupRoomySyncedChannels(bot, testGuildId);
  console.log(`Cleanup complete! Deleted ${deletedCount} channels.`);
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
