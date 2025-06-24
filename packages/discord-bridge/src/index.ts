// Discord Bridge functions for use by BridgeCard.svelte

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

// Store active clients and connections
const activeBridges = new Map<string, {
  client: Client;
  space: any;
  channel: any;
  admin: any;
  processedMessages: Set<string>;
}>();

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

export const WorkerProfile = co.profile({
  name: z.string(),
  imageUrl: z.string().optional(),
  description: z.string().optional(),
});

export const RoomyRoot = co.map({});

export const WorkerAccount = co.account({ profile: WorkerProfile, root: RoomyRoot });

// Initialize Jazz worker once for the module
let jazzWorker: any = null;

async function initJazzWorker() {
  if (!jazzWorker) {
    const accountID = process.env.JAZZ_WORKER_ACCOUNT;
    const accountSecret = process.env.JAZZ_WORKER_SECRET;
    const syncServer = `wss://cloud.jazz.tools/?key=${process.env.JAZZ_API_KEY}`;
    
    if (!accountID || !accountSecret) {
      throw new Error('Jazz credentials not set in environment variables: JAZZ_WORKER_ACCOUNT, JAZZ_WORKER_SECRET');
    }
    
    const { worker } = await startWorker({
      AccountSchema: WorkerAccount,
      accountID,
      accountSecret,
      syncServer,
    });
    jazzWorker = worker;
    console.log('Jazz worker initialized with account:', accountID);
  }
  return jazzWorker;
}

export async function startBridge(spaceId: string, channelId: string, guildId: string, discordToken?: string) {
  try {
    // Initialize Jazz worker
    await initJazzWorker();

    // Use provided token or fall back to environment variable
    const token = discordToken || process.env.DISCORD_TOKEN;
    if (!token) {
      throw new Error('Discord token is required');
    }
    
    console.log('Loading space and channel...', spaceId, channelId, guildId);

    // Load space and channel
    const space = await Space.load(spaceId);
    if (!space) throw new Error('Error loading space');
    console.log('Space loaded:', space.name);
    
    const admin = await Group.load(space.adminGroupId);
    if (!admin) throw new Error('Error loading admin');
    
    const channelObj = await Channel.load(channelId, {
      resolve: {
        mainThread: {
          timeline: {
            $each: true,
            $onError: null,
          }
        }
      }
    });
    if (!channelObj) throw new Error('Error loading channel');
    console.log('Channel loaded:', channelObj.name);    const processedMessages = new Set<string>();
    
    // Subscribe to timeline changes
    if (channelObj.mainThread?.timeline) {
      channelObj.mainThread.timeline.subscribe(async (timeline: any) => {
        const ids = Object.values(timeline.perAccount ?? {})
          .map((accountFeed: any) => new Array(...accountFeed.all))
          .flat()
          .sort((a: any, b: any) => a.madeAt.getTime() - b.madeAt.getTime())
          .map((a: any) => a.value);

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
    }

    // Setup Discord client and listen
    const client = await setupClient(guildId, token);
    await startListeningToDiscord(client, channelObj, admin, processedMessages);

    // Store the bridge connection
    const bridgeKey = `${spaceId}-${guildId}`;
    activeBridges.set(bridgeKey, {
      client,
      space,
      channel: channelObj,
      admin,
      processedMessages
    });

    return { success: true, bridgeKey };
  } catch (error) {
    console.error('Error starting bridge:', error);
    throw error;
  }
}

export async function stopBridge(bridgeKey: string): Promise<boolean> {
  try {
    const bridge = activeBridges.get(bridgeKey);
    if (!bridge) {
      return false;
    }

    // Disconnect Discord client
    bridge.client.destroy();
    
    // Remove from active bridges
    activeBridges.delete(bridgeKey);
    
    console.log(`Bridge ${bridgeKey} stopped successfully`);
    return true;
  } catch (error) {
    console.error('Error stopping bridge:', error);
    return false;
  }
}

export async function getBridgeStatus(bridgeKey: string): Promise<{ active: boolean; channels?: string[] }> {
  const bridge = activeBridges.get(bridgeKey);
  if (!bridge) {
    return { active: false };
  }

  try {
    // Get available Discord channels
    const guildId = bridgeKey.split('-').pop();
    if (!guildId) {
      return { active: true };
    }

    const channels = await getChannels(bridge.client, guildId);
    return { 
      active: true, 
      channels: channels?.channels?.map(c => c.name) || []
    };
  } catch (error) {
    return { active: true };
  }
}

let discordChannel: { id: string, name: string } | undefined;

async function setupClient(guildId: string, token: string) {
  if(!token) {
    throw new Error('DISCORD_TOKEN is not set');
  }

  const discordClient = createDiscordClient();
  const result = await discordClient.login(token);
  console.log('Discord client login result', result);

  console.log('Discord client logged in');

  const channels = await getChannels(discordClient, guildId);
  discordChannel = channels?.channels?.[0];

  return discordClient;
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

async function startListeningToDiscord(client: Client, channelObj: any, admin: any, processedMessages: Set<string>) {
  // Setup Discord message handler
  client.on(Events.MessageCreate, async (message) => {
    // Ignore bot messages to avoid loops
    if (message.author.bot) return;

    const messageId = `discord-${message.id}`;
    if (processedMessages.has(messageId)) return;
    processedMessages.add(messageId);
    
    try {
      // Get Discord avatar URL - similar to discord-import format
      let avatarUrl = message.author.displayAvatarURL({ size: 128 });
      
      if(!channelObj?.mainThread?.timeline || !admin) {
        console.log('No timeline or admin found', channelObj?.mainThread?.timeline, admin);
        return;
      }

      sendMessage(channelObj?.mainThread?.timeline, message.content, message.author.username, avatarUrl, admin);
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

// main function - only used for standalone testing
async function main() {
  const spaceId = process.env.SPACE_ID;
  const channelId = process.env.CHANNEL_ID;
  const guildId = process.env.GUILD_ID;
  const discordToken = process.env.DISCORD_TOKEN;
  
  if (!spaceId || !channelId || !guildId) {
    throw new Error('SPACE_ID, CHANNEL_ID, and GUILD_ID must be set');
  }
  
  await startBridge(spaceId, channelId, guildId, discordToken);
}

// Only run main if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}