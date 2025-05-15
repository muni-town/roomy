import { Client, GatewayIntentBits, TextChannel, Events, Webhook } from 'discord.js';
import express from 'express';
import type { Request, Response } from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { setGlobalDispatcher, EnvHttpProxyAgent } from 'undici'

// Add support for running behind an http proxy.
const envHttpProxyAgent = new EnvHttpProxyAgent()
setGlobalDispatcher(envHttpProxyAgent)

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

// Define channel mapping type
interface ChannelMapping {
  discordChannelId: string;
  discordChannelName: string;
  roomyChannelId: string;
  roomyChannelName: string;
}

// Define bridge data type - simpler now, only Discord client
interface BridgeData {
  discordClient: Client;
}

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

// Add a basic route for testing
app.get('/', (req: Request, res: Response) => {
  res.send('Discord-Roomy Bridge Server is running');
});

// Track active bridges by user session
const activeBridges = new Map<string, BridgeData>();

// Channel mappings per user
const channelMappings = new Map<string, ChannelMapping[]>();

// Track processed messages to avoid loops
const processedMessages = new Set<string>();

// Setup Discord client
function createDiscordClient(token: string): Client {
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

// REST API endpoint to fetch Discord channels
// @ts-ignore
app.post('/api/discord-channels', async (req: Request, res: Response) => {
  const { token, guildId } = req.body;
  
  if (!token || !guildId) {
    return res.status(400).json({ error: "Missing token or guild ID" });
  }
  
  try {
    const client = createDiscordClient(token);
    
    // Use a promise to wait for the client to be ready
    await new Promise<void>((resolve, reject) => {
      client.once(Events.ClientReady, () => resolve());
      client.once(Events.Error, reject);
      client.login(token).catch(reject);
    });
    
    // Fetch guild and channels
    const guild = await client.guilds.fetch(guildId);
    if (!guild) {
      await client.destroy();
      return res.status(404).json({ error: "Guild not found" });
    }
    
    const channels = await guild.channels.fetch();
    const textChannels = channels.filter(channel => 
      channel?.type === 0 || channel?.type === 5 // TextChannel or AnnouncementChannel
    ).map(channel => ({
      id: channel.id,
      name: channel.name
    }));
    
    await client.destroy();
    
    return res.json({ channels: textChannels });
  } catch (error) {
    console.error("Error fetching Discord channels:", error);
    return res.status(500).json({ error: "Failed to fetch Discord channels" });
  }
});

// WebSocket handling
io.on('connection', (socket) => {
  console.log("New client connected:", socket.id);
  
  // Start bridge
  socket.on('startBridge', async (data: {
    discordToken: string;
    mappings: ChannelMapping[];
  }) => {
    const { discordToken, mappings } = data;
    
    if (!discordToken || !mappings || mappings.length === 0) {
      socket.emit('bridgeStatus', { 
        success: false, 
        message: "Missing required data" 
      });
      return;
    }
    
    try {
      // Initialize Discord client
      const discordClient = createDiscordClient(discordToken);
      await discordClient.login(discordToken);
      
      // Save mappings
      channelMappings.set(socket.id, mappings);
      
      // Setup Discord message handler
      discordClient.on(Events.MessageCreate, async (message) => {
        // Ignore bot messages to avoid loops
        if (message.author.bot) return;
        
        // Find the mapping for this channel
        const mapping = mappings.find(m => m.discordChannelId === message.channelId);
        if (!mapping) return;
        
        const messageId = `discord-${message.id}`;
        if (processedMessages.has(messageId)) return;
        processedMessages.add(messageId);
        
        try {
          // Get Discord avatar URL - similar to discord-import format
          let avatarUrl = message.author.displayAvatarURL({ size: 128 });
          
          // Send the message to the client to handle on the Roomy side
          socket.emit('discordMessage', {
            content: message.content,
            author: {
              username: message.author.username,
              id: message.author.id,
              avatarUrl: avatarUrl
            },
            mapping: mapping,
            discordMessageId: message.id,
            timestamp: message.createdTimestamp
          });
          
          // Clean up message ID after a delay
          setTimeout(() => {
            processedMessages.delete(messageId);
          }, 60000);
          
        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          console.error('Error processing Discord message:', error);
          socket.emit('messageStatus', {
            direction: "discord-to-roomy",
            success: false,
            message: `Error: ${errorMessage}`
          });
        }
      });
      
      // Store in active bridges
      activeBridges.set(socket.id, { discordClient });
      
      socket.emit('bridgeStatus', { 
        success: true, 
        message: "Bridge started successfully" 
      });
      
      console.log(`Bridge started for session ${socket.id}`);
      
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error("Error starting bridge:", error);
      socket.emit('bridgeStatus', { success: false, message: errorMessage });
    }
  });
  
  // Handle messages from Roomy to Discord
  socket.on('roomyMessage', async (data: {
    content: string;
    mapping: ChannelMapping;
    author?: string;
    avatarUrl?: string;
  }) => {
    const { content, mapping, author, avatarUrl } = data;
    const bridge = activeBridges.get(socket.id);
    
    if (!bridge || !bridge.discordClient) {
      socket.emit('messageStatus', {
        direction: "roomy-to-discord",
        success: false,
        message: "No active Discord client"
      });
      return;
    }
    
    try {
      // Get the Discord channel
      const channel = await bridge.discordClient.channels.fetch(mapping.discordChannelId) as TextChannel;
      if (!channel) {
        throw new Error(`Discord channel ${mapping.discordChannelName} not found`);
      }
      
      // Use webhook approach if author is provided
      if (author) {
        // Find existing webhook or create new one
        let webhook = await findOrCreateWebhook(channel, bridge.discordClient);
        
        // Send the message with custom username and optional avatar
        await webhook.send({
          content: content,
          username: author,
          avatarURL: avatarUrl || undefined
        });
      } else {
        // Fallback to regular message
        await channel.send(content);
      }
      
      socket.emit('messageStatus', {
        direction: "roomy-to-discord",
        success: true,
        message: `Message sent to Discord channel ${mapping.discordChannelName}`
      });
      
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Error sending message to Discord:', error);
      socket.emit('messageStatus', {
        direction: "roomy-to-discord",
        success: false,
        message: `Error: ${errorMessage}`
      });
    }
  });
  
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
          avatar: 'https://i.imgur.com/AfFp7pu.png', // Default avatar, change to your app's logo
          reason: 'Created for Roomy-Discord bridge'
        });
      }
      
      return webhook;
    } catch (error) {
      console.error('Error creating webhook:', error);
      throw new Error('Failed to create webhook for message customization');
    }
  }

  // Stop bridge
  socket.on('stopBridge', async () => {
    try {
      const bridge = activeBridges.get(socket.id);
      if (!bridge) {
        socket.emit('bridgeStatus', { success: false, message: "No active bridge found" });
        return;
      }
      
      // Cleanup Discord client
      if (bridge.discordClient) {
        await bridge.discordClient.destroy();
      }
      
      // Remove from active bridges
      activeBridges.delete(socket.id);
      channelMappings.delete(socket.id);
      
      socket.emit('bridgeStatus', { success: true, message: "Bridge stopped successfully" });
      console.log(`Bridge stopped for session ${socket.id}`);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error("Error stopping bridge:", error);
      socket.emit('bridgeStatus', { success: false, message: errorMessage });
    }
  });
  
  // Test connection endpoint
  socket.on('testConnection', () => {
    socket.emit('testConnectionResponse', { success: true, message: "Connection is working" });
  });
  
  // Handle disconnection
  socket.on('disconnect', async () => {
    console.log("Client disconnected:", socket.id);
    
    // Cleanup resources
    const bridge = activeBridges.get(socket.id);
    if (bridge && bridge.discordClient) {
      await bridge.discordClient.destroy();
    }
    
    // Remove session data
    activeBridges.delete(socket.id);
    channelMappings.delete(socket.id);
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`Discord-Roomy bridge server running on port ${PORT}`);
});