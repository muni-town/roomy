import express from 'express';
import cors from 'cors';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path, { dirname } from 'path';
import { setGlobalDispatcher, EnvHttpProxyAgent } from 'undici';
import { Account, co } from 'jazz-tools';
import { loadThreadsAndStartListening, RoomyMessage, sendMessage, setupWorker } from './jazz.js';
import { Client, TextChannel } from 'discord.js';
import { DiscordMessage, getChannels, sendMessageToDiscord, setupDiscordClient, startListeningToDiscord } from './discord.js';
import { DiscordBridgeRequest } from '@roomy-chat/sdk';
import TurndownService from 'turndown';
import { marked } from 'marked';


const turndownService = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-'
});
// Add support for running behind an http proxy.
const envHttpProxyAgent = new EnvHttpProxyAgent();
setGlobalDispatcher(envHttpProxyAgent);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const app = express();
const PORT = process.env.PORT || 3001;

let discordClient: Client | null = null;
let jazzWorker: Account | null = null;

let processedMessages: Set<string> = new Set();

type BridgeData = {
  discordChannels: Map<string, TextChannel>,
  roomyThreads: Map<string, any>,
  guildId: string,
  roomySpaceId: string,
}
const roomyToDiscordMap: Map<string, BridgeData> = new Map();
const discordToRoomyMap: Map<string, BridgeData> = new Map();

app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'discord-bridge',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// Status endpoint to check active bridges
app.get('/status', (req, res) => {
  res.json({
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage()
  });
});

let requests: co.loaded<typeof DiscordBridgeRequest>[] = [];

async function initializeJazz() {
  try {
    console.log("Initializing Jazz worker...");
    const { worker, profile } = await setupWorker();

    jazzWorker = worker;

    // load all existing requests
    console.log("requests", profile.requests);
    for(const request of profile.requests) {
      console.log('Request:', request);

      const bridgeData: BridgeData = {
        discordChannels: new Map(),
        roomyThreads: new Map(),
        guildId: request.discordGuildId,
        roomySpaceId: request.roomySpaceId,
      }
      
      roomyToDiscordMap.set(request.roomySpaceId, bridgeData);
      discordToRoomyMap.set(request.discordGuildId, bridgeData);

      const channels = await getChannels(discordClient, request.discordGuildId);
      for(const channelInfo of channels) {
        const channel = channelInfo[1];
        bridgeData.discordChannels.set(channel.name, channel);
      }

      const threads = await loadThreadsAndStartListening(jazzWorker, request.roomySpaceId, onRoomyMessage);
      for(const thread of threads) {
        bridgeData.roomyThreads.set(thread.thread.name, thread);
      }

      console.log('bridgeData', bridgeData);
    }
  } catch (error) {
    console.error('Failed to initialize Jazz worker:', error);
    process.exit(1);
  }
}

async function initializeDiscord() {
  console.log("Initializing Discord client...");
  discordClient = await setupDiscordClient(process.env.DISCORD_TOKEN, envHttpProxyAgent);

  startListeningToDiscord(discordClient, onDiscordMessage);
}

async function onDiscordMessage(message: DiscordMessage) {
  if(processedMessages.has(message.messageId)) {
    console.log('Message already processed:', message.messageId);
    return;
  }

  processedMessages.add(message.messageId);

  console.log('Discord message:', message);

  const bridgeData = discordToRoomyMap.get(message.guildId);
  if (!bridgeData) {
    console.log('No bridge data found for guild:', message.guildId);
    return;
  }

  const roomyThread = bridgeData.roomyThreads.get(message.channelName);

  if (!roomyThread) {
    console.log('No roomy thread found for channel:', message.channelName);
    return;
  }

  const timeline = roomyThread.content.timeline;
  if(!timeline) {
    console.log('No timeline found for thread:', message.channelName);
    return;
  }

  const content = await marked.parse(message.content);

  sendMessage(timeline, content, message.author.username, message.author.avatarUrl, roomyThread.adminGroup);
}

function onRoomyMessage(message: RoomyMessage) {
  if(processedMessages.has(message.messageId)) {
    console.log('Message already processed:', message.messageId);
    return;
  }

  processedMessages.add(message.messageId);

  const bridgeData = roomyToDiscordMap.get(message.spaceId);
  if (!bridgeData) {
    console.log('No bridge data found for space:', message.spaceId);
    return;
  }

  const discordChannel = bridgeData.discordChannels.get(message.channelName);
  if(!discordChannel) {
    console.log('No discord channel found for channel:', message.channelName);
    return;
  }

  const markdown = turndownService.turndown(message.message);

  sendMessageToDiscord(discordClient, discordChannel, {
    username: message.author,
    content: markdown,
    avatarUrl: message.avatarUrl
  });
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down Discord Bridge server...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Shutting down Discord Bridge server...');
  process.exit(0);
});

async function init() {
  await initializeDiscord();
  await initializeJazz();
}

// Start the server
app.listen(PORT, () => {
  console.log(`Discord Bridge server running on port ${PORT}`);
  console.log(`Health check available at http://localhost:${PORT}/health`);
  
  init();
});
