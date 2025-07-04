// Discord Bridge functions for use by BridgeCard.svelte

import { Client, GatewayIntentBits, TextChannel, Events } from 'discord.js';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path, { dirname } from 'path';
import { setGlobalDispatcher, EnvHttpProxyAgent } from 'undici'
import { startWorker, co, Group, z, Channel, Message, RoomyProfile, Space } from "@roomy-chat/sdk";
import { sendMessage } from './send.js';

// Add support for running behind an http proxy.
const envHttpProxyAgent = new EnvHttpProxyAgent()
setGlobalDispatcher(envHttpProxyAgent)

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

// Store active clients and connections
export const activeBridges = new Map<string, {
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

async function setupClient(guildId: string, token: string): Promise<Client> {
  const client = createDiscordClient();
  
  await client.login(token);
  
  // Wait for client to be ready
  await new Promise<void>((resolve) => {
    client.once('ready', () => {
      console.log(`Discord client logged in as ${client.user?.tag}`);
      resolve();
    });
  });

  return client;
}

async function startListeningToDiscord(
  client: Client, 
  channelObj: any, 
  admin: any, 
  processedMessages: Set<string>
) {
  client.on(Events.MessageCreate, async (discordMessage) => {
    if (discordMessage.author.bot) return;
    if (processedMessages.has(discordMessage.id)) return;

    processedMessages.add(discordMessage.id);

    try {
      // Send message to Roomy
      await sendMessage(
        channelObj.mainThread.timeline,
        discordMessage.content,
        discordMessage.author.username,
        discordMessage.author.displayAvatarURL(),
        admin
      );

      console.log(`Synced Discord message to Roomy: ${discordMessage.content.substring(0, 50)}...`);
    } catch (error) {
      console.error('Error syncing Discord message to Roomy:', error);
    }
  });
}

async function findOrCreateWebhook(channel: TextChannel, client: Client) {
  try {
    const webhooks = await channel.fetchWebhooks();
    let webhook = webhooks.find(wh => wh.name === 'Roomy Bridge');
    
    if (!webhook) {
      webhook = await channel.createWebhook({
        name: 'Roomy Bridge',
        reason: 'Bridge messages from Roomy to Discord',
      });
    }
    
    return webhook;
  } catch (error) {
    console.error('Error creating webhook:', error);
    throw new Error('Failed to create webhook for message customization');
  }
}

export const WorkerProfile = co.profile({
  name: z.string(),
  imageUrl: z.string().optional(),
  description: z.string().optional(),
});

export const WorkerAccount = co.account({
  profile: WorkerProfile,
  root: co.map({}),
});

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
          }          const name = author?.name;
          const avatarUrl = author?.imageUrl;

          // Find Discord channel in the guild
          const guild = client.guilds.cache.get(guildId);
          if (!guild) {
            console.log('Discord guild not found');
            return;
          }

          const discordChannel = guild.channels.cache.find(ch => ch.name === channelObj.name);
          if(!discordChannel || discordChannel.type !== 0) { // 0 = text channel
            console.log('No matching Discord text channel found');
            return;
          }

          const channel = discordChannel as TextChannel;
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

export async function stopBridge(bridgeId: string) {
  try {
    const bridge = activeBridges.get(bridgeId);
    if (!bridge) {
      console.log(`Bridge ${bridgeId} not found or already stopped`);
      return;
    }

    // Disconnect Discord client
    if (bridge.client) {
      bridge.client.destroy();
    }

    // Remove from active bridges
    activeBridges.delete(bridgeId);
    
    console.log(`Bridge ${bridgeId} stopped successfully`);
  } catch (error) {
    console.error(`Error stopping bridge ${bridgeId}:`, error);
    throw error;
  }
}

export function getBridgeStatus() {
  return {
    activeBridges: activeBridges.size,
    bridges: Array.from(activeBridges.keys())
  };
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