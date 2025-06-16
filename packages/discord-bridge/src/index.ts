// this currently only works for one hardcoded space and channel
// should instead work like specified in Readme.md

import { Client, GatewayIntentBits, TextChannel, Events } from 'discord.js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path, { dirname } from 'path';
import { setGlobalDispatcher, EnvHttpProxyAgent } from 'undici'
import { startWorker } from 'jazz-nodejs';
import { co, Group, z } from "jazz-tools";
import { Channel, Message, RoomyProfile, Space } from './schema.js';
import { sendMessage } from './send.js';

// Add support for running behind an http proxy.
const envHttpProxyAgent = new EnvHttpProxyAgent()
setGlobalDispatcher(envHttpProxyAgent)

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

function createDiscordClient(): Client {
  const client = new Client({
    rest: {
      agent: envHttpProxyAgent,
    },
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ]
  });
  
  return client;
}

const discordToken = process.env.DISCORD_TOKEN;

export const WorkerProfile = co.profile({
  name: z.string(),
  imageUrl: z.string().optional(),
  description: z.string().optional(),
});

export const RoomyRoot = co.map({
});

export const WorkerAccount = co
  .account({
    profile: WorkerProfile,
    root: RoomyRoot,
  })

const { worker } = await startWorker({
  AccountSchema: WorkerAccount,
  syncServer: 'wss://cloud.jazz.tools/?key=' + process.env.JAZZ_API_KEY,
});

const space = await Space.load(process.env.SPACE_ID ?? "");
if(!space) {
  throw new Error('Error loading space');
}

const admin = await Group.load(space.adminGroupId);
if(!admin) {
  throw new Error('Error loading admin');
}

const channel = await Channel.load(process.env.CHANNEL_ID ?? "", {
  resolve: {
    mainThread: {
      timeline: {
        $each: true,
        $onError: null,
      }
    }
  }
});

const processedMessages = new Set<string>();

channel?.mainThread?.timeline?.subscribe(async (timeline) => {
  const ids = Object.values(timeline.perAccount ?? {})
    .map((accountFeed) => new Array(...accountFeed.all))
    .flat()
    .sort((a, b) => a.madeAt.getTime() - b.madeAt.getTime())
    .map((a) => a.value);

  for(const id of ids) {
    if(processedMessages.has(id)) continue;

    processedMessages.add(id);

    const message = await Message.load(id);
    if(!message) {
      continue;
    }

    // check if message is less than 10 seconds old
    if(Date.now() - message.createdAt.getTime() > 10000) {
      console.log('Message is more than 10 seconds old, skipping', message.createdAt);
      continue;
    }

    if(message.author?.startsWith('discord:')) {
      console.log('Message is from discord, skipping', message.author);
      continue;
    }

    const authorId = message._edits.content?.by?.profile?.id;
    if(!authorId) {
      console.log('No author id found', message);
      continue;
    }

    const author = await RoomyProfile.load(authorId);
    if(!author) {
      console.log('Failed to load author', authorId);
      continue;
    }

    const name = author?.name;
    const avatarUrl = author?.imageUrl;

    if(!discordChannel) {
      console.log('No discord channel found');
      return;
    }

    const channel = await client.channels.fetch(discordChannel.id) as TextChannel;
    if (!channel) {
      throw new Error(`Discord channel ${discordChannel.name} not found`);
    }
    let webhook = await findOrCreateWebhook(channel, client);

    await webhook.send({
      content: message.content,
      username: name,
      avatarURL: avatarUrl || undefined
    });
  }
});

if(!channel) {
  throw new Error('Error loading channel');
}

let client: Client;

let discordChannel: { id: string, name: string } | undefined;

async function setupClient() {
  if(!discordToken) {
    throw new Error('DISCORD_TOKEN is not set');
  }

  const discordClient = createDiscordClient();
  const result = await discordClient.login(discordToken);
  console.log('Discord client login result', result);

  console.log('Discord client logged in');

  client = discordClient;

  const channels = await getChannels(client, process.env.GUILD_ID ?? "");
  console.log(channels);
  discordChannel = channels?.channels?.[0];
}
async function getChannels(client: Client, guildId: string) {
  const guild = await client.guilds.fetch(guildId);
  if(!guild) return;

  const channels = await guild.channels.fetch();
  const textChannels = channels.filter(channel => 
    channel?.type === 0 || channel?.type === 5 // TextChannel or AnnouncementChannel
  ).map(channel => ({
    id: channel.id,
    name: channel.name
  }));
  
  return { channels: textChannels };
}

async function startListeningToDiscord(client: Client) {
  // Setup Discord message handler
  client.on(Events.MessageCreate, async (message) => {
    // Ignore bot messages to avoid loops
    if (message.author.bot) return;

    const messageId = `discord-${message.id}`;
    if (processedMessages.has(messageId)) return;
    processedMessages.add(messageId);;
    
    try {
      // Get Discord avatar URL - similar to discord-import format
      let avatarUrl = message.author.displayAvatarURL({ size: 128 });
      
      if(!channel?.mainThread?.timeline || !admin) {
        console.log('No timeline or admin found', channel?.mainThread?.timeline, admin);
        return;
      }

      sendMessage(channel?.mainThread?.timeline, message.content, message.author.username, avatarUrl, admin);
    } catch (error: unknown) {
      console.error('Error processing Discord message:', error);
    }
  });
}
  
// Helper function to find or create webhook
async function findOrCreateWebhook(channel: TextChannel, client: Client) {
  try {
    // Check for existing webhooks
    const webhooks = await channel.fetchWebhooks();
    let webhook = webhooks.find(wh => wh.name === 'RoomyBridge');
    
    // Create webhook if it doesn't exist
    if (!webhook) {
      webhook = await channel.createWebhook({
        name: 'RoomyBridge',
        avatar: 'https://i.imgur.com/AfFp7pu.png',
        reason: 'Created for Roomy-Discord bridge'
      });
    }
    
    return webhook;
  } catch (error) {
    console.error('Error creating webhook:', error);
    throw new Error('Failed to create webhook for message customization');
  }
}


// main function
async function main() {
  await setupClient();
  await startListeningToDiscord(client);
}

main();