/**
 * Quick script to inspect the test Discord guild structure
 * Run with: pnpm exec tsx --env-file=.env scripts/inspect-test-guild.ts
 */

import { createBot, ChannelTypes } from "@discordeno/bot";
import { desiredProperties } from "../src/discord/types.js";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const TEST_GUILD_ID = process.env.TEST_GUILD_ID;

if (!DISCORD_TOKEN) {
  console.error("DISCORD_TOKEN environment variable not set");
  process.exit(1);
}

if (!TEST_GUILD_ID) {
  console.error("TEST_GUILD_ID environment variable not set");
  process.exit(1);
}

async function inspectGuild() {
  // Create bot without gateway connection (REST only)
  const bot = await createBot({
    token: DISCORD_TOKEN,
    desiredProperties,
  });

  console.log("\n=== Inspecting Test Guild ===");
  console.log("Guild ID:", TEST_GUILD_ID);

  const guildId = BigInt(TEST_GUILD_ID);

  try {
    // Get all channels
    const channels = await bot.helpers.getChannels(guildId);
    console.log(`\nTotal channels: ${channels.length}`);

    // Group by type
    const categories = channels.filter((c) => c.type === ChannelTypes.GuildCategory);
    const textChannels = channels.filter((c) => c.type === ChannelTypes.GuildText);
    const forumChannels = channels.filter((c) => c.type === ChannelTypes.GuildForum);
    const voiceChannels = channels.filter((c) => c.type === ChannelTypes.GuildVoice);
    const threads = channels.filter((c) =>
      c.type === ChannelTypes.GuildPublicThread ||
      c.type === ChannelTypes.GuildPrivateThread
    );

    console.log(`\n=== Structure ===`);
    console.log(`Categories: ${categories.length}`);
    for (const cat of categories) {
      const children = channels.filter((c) => c.parentId === cat.id);
      console.log(`  - ${cat.name} (${children.length} children)`);
      for (const child of children) {
        const typeLabel = child.type === ChannelTypes.GuildForum ? "[Forum]" :
                         child.type === ChannelTypes.GuildVoice ? "[Voice]" :
                         child.type === ChannelTypes.GuildText ? "[Text]" :
                         child.type === ChannelTypes.GuildPublicThread ? "[Thread]" : "[Unknown]";
        console.log(`      - ${child.name} ${typeLabel}`);
      }
    }

    console.log(`\nText Channels (no parent): ${textChannels.filter((c) => !c.parentId).length}`);
    for (const ch of textChannels.filter((c) => !c.parentId)) {
      console.log(`  - ${ch.name} (id: ${ch.id})`);
    }

    console.log(`\nForum Channels: ${forumChannels.length}`);
    for (const f of forumChannels) {
      console.log(`  - ${f.name} (id: ${f.id})`);
      // Get threads in forum
      try {
        const activeThreads = await bot.helpers.getActiveThreads(guildId);
        const forumThreads = activeThreads.threads.filter((t: any) => t.parentId === f.id);
        console.log(`    Threads: ${forumThreads.length}`);
        for (const t of forumThreads) {
          console.log(`      - ${t.name}`);
        }
      } catch (e) {
        console.log(`    (could not fetch threads: ${e})`);
      }
    }

    console.log(`\nVoice Channels: ${voiceChannels.length}`);
    for (const v of voiceChannels) {
      console.log(`  - ${v.name}`);
    }

    console.log(`\nThreads (orphaned, no parent): ${threads.filter((t) => !t.parentId).length}`);
    for (const t of threads.filter((t) => !t.parentId)) {
      console.log(`  - ${t.name} (id: ${t.id})`);
    }

    // Get some sample messages from each text channel
    console.log(`\n=== Sample Messages (last 3) ===`);
    for (const ch of textChannels) {
      try {
        const messages = await bot.helpers.getMessages(ch.id, { limit: 5 });
        console.log(`\n#${ch.name}: ${messages.length} messages total`);
        for (const msg of messages.slice(0, 3).reverse()) {
          const hasReactions = msg.reactions?.length ?? 0;
          const isEdited = msg.editedTimestamp ? " [edited]" : "";
          const hasAttachments = msg.attachments?.length ?? 0;
          const contentPreview = msg.content
            ? `"${msg.content.slice(0, 50)}${msg.content.length > 50 ? "..." : ""}"`
            : "(no content)";
          console.log(`  - ${msg.author?.username ?? "Unknown"}: ${contentPreview} ${isEdited}[reactions: ${hasReactions}][attachments: ${hasAttachments}]`);
        }
      } catch (e) {
        console.log(`  (could not fetch messages: ${(e as Error).message})`);
      }
    }

    console.log("\n=== Summary ===");
    console.log(`Categories: ${categories.length}`);
    console.log(`Text channels: ${textChannels.length}`);
    console.log(`Forum channels: ${forumChannels.length}`);
    console.log(`Voice channels: ${voiceChannels.length}`);
    console.log(`Threads: ${threads.length}`);
  } catch (error) {
    console.error("Error inspecting guild:", error);
  }

  process.exit(0);
}

inspectGuild().catch(console.error);
