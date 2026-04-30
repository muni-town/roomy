#!/usr/bin/env tsx
/**
 * Debug script to inspect reactions on a specific Discord message.
 * Run with: pnpm tsx scripts/debug-reactions.ts
 */

import { config } from "dotenv";
config();

import { createBot } from "@discordeno/bot";
import { desiredProperties } from "../src/discord/types.js";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN!;
if (!DISCORD_TOKEN) {
  throw new Error("DISCORD_TOKEN not set in environment");
}

const TEST_MESSAGE_ID = 1469101527456288964n;
const TEST_CHANNEL_ID = 1469088863317135453n;

async function main() {
  console.log("Creating bot...");
  const bot = await createBot({
    token: DISCORD_TOKEN,
    desiredProperties,
  });

  console.log(`\n=== Fetching message ${TEST_MESSAGE_ID} from channel ${TEST_CHANNEL_ID} ===`);

  try {
    // Fetch the specific message
    const message = await bot.helpers.getMessage(TEST_CHANNEL_ID, TEST_MESSAGE_ID);

    console.log("\nMessage found:");
    console.log(`  ID: ${message.id}`);
    console.log(`  Content: ${message.content?.substring(0, 100) || "(empty)"}`);
    console.log(`  Author: ${message.author?.username} (${message.author?.id})`);

    // Check reactions property
    console.log("\n=== Reactions property ===");
    const reactions = (message as any).reactions;
    console.log(`  Type: ${typeof reactions}`);
    console.log(`  Is array: ${Array.isArray(reactions)}`);
    console.log(`  Value:`, JSON.stringify(reactions, null, 2));

    if (reactions && Array.isArray(reactions) && reactions.length > 0) {
      console.log(`\nFound ${reactions.length} reaction types:`);
      for (const reaction of reactions) {
        console.log(`  - Emoji: ${JSON.stringify(reaction.emoji)}, Count: ${reaction.count}`);
      }
    } else {
      console.log("\n⚠️  No reactions found on message object via Discordeno");
    }

    // Try direct REST API call to get message with reactions
    console.log("\n=== Trying direct REST API call ===");
    const restUrl = `https://discord.com/api/v10/channels/${TEST_CHANNEL_ID}/messages/${TEST_MESSAGE_ID}`;
    console.log(`Fetching: ${restUrl}`);

    const restResponse = await fetch(restUrl, {
      headers: {
        'Authorization': `Bot ${DISCORD_TOKEN}`,
      },
    });

    if (restResponse.ok) {
      const restMessage = await restResponse.json();
      console.log("\nREST API Response:");
      console.log(`  Has reactions property: ${!!restMessage.reactions}`);
      if (restMessage.reactions && Array.isArray(restMessage.reactions)) {
        console.log(`  Found ${restMessage.reactions.length} reaction types via REST:`);
        for (const r of restMessage.reactions) {
          const isCustom = !!r.emoji.id;
          const emojiStr = isCustom ? `<${r.emoji.animated ? 'a' : ''}:${r.emoji.name}:${r.emoji.id}>` : r.emoji.name;
          console.log(`  - ${emojiStr}: ${r.count} users`);
        }
      }
    } else {
      console.log(`  REST API failed: ${restResponse.status} ${restResponse.statusText}`);
    }

    // Try fetching reactions via API for each emoji
    console.log("\n=== Fetching reactions via getReactions API ===");

    // Extended list of common unicode emojis
    const testEmojis = [
      "👍", "👎", "❤️", "🔥", "🎉", "😀", "😂", "😮", "😢", "🎨", "🕶️",
      "✅", "❌", "👀", "🚀", "💯", "🏆", "⭐", "💪", "🤔", "👏", "🙏",
      "💀", "😈", "🤖", "👻", "🎃", "🦊", "🐱", "🐶", "🌈", "☀️"
    ];

    let foundReactions = 0;
    for (const emoji of testEmojis) {
      try {
        console.log(`\nTrying emoji "${emoji}"...`);
        const users = await bot.helpers.getReactions(TEST_CHANNEL_ID, TEST_MESSAGE_ID, emoji);

        if (users.length > 0) {
          foundReactions++;
          console.log(`  ✅ Found ${users.length} users who reacted with ${emoji}:`);
          for (const user of users) {
            console.log(`     - ${user.username} (${user.id})`);
          }
        } else {
          console.log(`  (no users reacted with ${emoji})`);
        }
      } catch (error: any) {
        console.log(`  ❌ Error: ${error.message}`);
      }
    }

    console.log(`\n=== Summary ===`);
    console.log(`Found reactions with ${foundReactions} different emoji types`);

    // Also try to fetch messages from the channel to see reactions property
    console.log("\n=== Fetching recent messages from channel ===");
    console.log("\nUsing bot.helpers.getMessages() with reactions in desiredProperties:");

    const helperMessages = await bot.helpers.getMessages(TEST_CHANNEL_ID, { limit: 10 });
    let helperMessagesWithReactions = 0;

    for (const msg of helperMessages) {
      const msgReactions = (msg as any).reactions;
      if (msgReactions && Array.isArray(msgReactions) && msgReactions.length > 0) {
        helperMessagesWithReactions++;
        console.log(`\nMessage ${msg.id} "${msg.content?.substring(0, 40)}" has ${msgReactions.length} reaction types:`);
        for (const r of msgReactions) {
          const isCustom = !!r.emoji.id;
          const emojiStr = isCustom ? `<${r.emoji.animated ? 'a' : ''}:${r.emoji.name}:${r.emoji.id}>` : r.emoji.name;
          console.log(`  - ${emojiStr}: ${r.count} users`);
        }
      }
    }

    console.log(`\nMessages with reactions: ${helperMessagesWithReactions}/${helperMessages.length}`);

    if (helperMessagesWithReactions > 0) {
      console.log("\n✅ bot.helpers.getMessages() now populates reactions with desiredProperties!");
    } else {
      console.log("\n⚠️  Still no reactions found - desiredProperties may need a rebuild");
    }

  } catch (error: any) {
    console.error("Error:", error.message);
    console.error(error.stack);
  }
}

main().catch(console.error);
