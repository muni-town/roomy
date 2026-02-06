#!/usr/bin/env tsx
/**
 * Run cleanup of test artifacts in the Discord test guild.
 *
 * Usage:
 *   tsx scripts/run-cleanup.ts              # Interactive prompt
 *   tsx scripts/run-cleanup.ts messages     # Clean all messages from test channels
 *   tsx scripts/run-cleanup.ts webhooks     # Clean all webhook messages from ALL text channels
 *   tsx scripts/run-cleanup.ts bot          # Clean all bot messages from ALL text channels
 *   tsx scripts/run-cleanup.ts channels     # Delete all test channels
 *   tsx scripts/run-cleanup.ts all         # Clean messages, then delete channels
 *
 * Environment variables required:
 *   TEST_GUILD_ID - Discord guild ID to clean
 *   DISCORD_TOKEN - Discord bot token
 */

import "dotenv/config";
import { createBot } from "@discordeno/bot";
import { cleanupRoomySyncedChannels, cleanupTestMessages, cleanupWebhookMessages, cleanupBotMessages } from "../tests/e2e/helpers/setup.js";

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

type CleanupMode = "messages" | "webhooks" | "bot" | "channels" | "all";

async function main() {
  const testGuildId = process.env.TEST_GUILD_ID;
  if (!testGuildId) {
    console.error("❌ TEST_GUILD_ID environment variable not set");
    process.exit(1);
  }

  const discordToken = process.env.DISCORD_TOKEN;
  if (!discordToken) {
    console.error("❌ DISCORD_TOKEN environment variable not set");
    process.exit(1);
  }

  // Determine cleanup mode from CLI args
  let mode: CleanupMode = "all"; // default

  const args = process.argv.slice(2);
  if (args.length === 1) {
    const arg = args[0]?.toLowerCase();
    if (arg && (arg === "messages" || arg === "webhooks" || arg === "bot" || arg === "channels" || arg === "all")) {
      mode = arg;
    } else {
      console.error(`❌ Unknown cleanup mode: ${arg}`);
      console.error("   Valid modes: messages, webhooks, bot, channels, all");
      process.exit(1);
    }
  } else if (args.length > 1) {
    console.error("❌ Too many arguments");
    console.error("   Usage: tsx scripts/run-cleanup.ts [messages|webhooks|bot|channels|all]");
    process.exit(1);
  }

  console.log("Creating bot...");
  const bot = await createBot({
    token: discordToken,
    desiredProperties,
  });

  console.log(`\n🧹 Running cleanup for guild ${testGuildId}...\n`);

  let messagesDeleted = 0;
  let channelsDeleted = 0;

  // Clean messages first (if requested)
  if (mode === "messages" || mode === "all") {
    console.log("📝 Step 1: Cleaning messages from test channels...");
    messagesDeleted = await cleanupTestMessages(bot as any, testGuildId);
    console.log(`   ✅ Deleted ${messagesDeleted} messages\n`);
  }

  // Clean webhook messages (if requested)
  if (mode === "webhooks") {
    console.log("🔗 Step 1: Cleaning webhook messages from ALL text channels...");
    messagesDeleted = await cleanupWebhookMessages(bot as any, testGuildId);
    console.log(`   ✅ Deleted ${messagesDeleted} webhook messages\n`);
  }

  // Clean bot messages (if requested)
  if (mode === "bot") {
    console.log("🤖 Step 1: Cleaning bot messages from ALL text channels...");
    messagesDeleted = await cleanupBotMessages(bot as any, testGuildId);
    console.log(`   ✅ Deleted ${messagesDeleted} bot messages\n`);
  }

  // Delete channels (if requested)
  if (mode === "channels" || mode === "all") {
    const stepNum = mode === "all" ? "2" : "1";
    console.log(`🗑️  Step ${stepNum}: Deleting test channels...`);
    channelsDeleted = await cleanupRoomySyncedChannels(bot as any, testGuildId);
    console.log(`   ✅ Deleted ${channelsDeleted} channels\n`);
  }

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("✨ Cleanup complete!");
  if (messagesDeleted > 0) console.log(`   Messages deleted: ${messagesDeleted}`);
  if (channelsDeleted > 0) console.log(`   Channels deleted: ${channelsDeleted}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
}

main().catch((error) => {
  console.error("❌ Error:", error);
  process.exit(1);
});
