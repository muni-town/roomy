import express, { Request, Response } from 'express';
import cors from 'cors';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path, { dirname } from 'path';
import { setGlobalDispatcher, EnvHttpProxyAgent } from 'undici';
import { startWorker, co, Group, Account, RoomyAccount, BridgeConfig, BridgeConfigList, Space } from "@roomy-chat/sdk";
import { startBridge, stopBridge, activeBridges, getBridgeStatus } from './index.js';
import { Client, GatewayIntentBits } from 'discord.js';

// Add support for running behind an http proxy.
const envHttpProxyAgent = new EnvHttpProxyAgent();
setGlobalDispatcher(envHttpProxyAgent);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Validate Discord bot token and guild access
async function validateDiscordToken(token: string, guildId: string): Promise<{ valid: boolean; error?: string; botInfo?: any }> {
  let client: Client | null = null;
  
  try {
    console.log('Validating Discord token and guild access...');
    
    // Create a temporary client to test the token
    client = new Client({
      rest: {
        agent: envHttpProxyAgent,
      },
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ]
    });
    
    // Set a timeout for the login attempt
    const loginTimeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Discord login timeout')), 10000);
    });
    
    // Attempt to login
    await Promise.race([
      client.login(token),
      loginTimeout
    ]);
    
    console.log('Discord client logged in successfully');
    
    // Wait for the client to be ready
    await new Promise((resolve, reject) => {
      const readyTimeout = setTimeout(() => {
        reject(new Error('Discord client ready timeout'));
      }, 5000);
      
      client!.once('ready', () => {
        clearTimeout(readyTimeout);
        resolve(true);
      });
    });
    
    // Check if bot can access the specified guild
    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
      // Try to fetch the guild if not in cache
      try {
        await client.guilds.fetch(guildId);
      } catch (fetchError) {
        return {
          valid: false,
          error: `Bot does not have access to guild ${guildId}. Make sure the bot is invited to the server with proper permissions.`
        };
      }
    }
    
    // Get bot information
    const botUser = client.user;
    const botInfo = {
      id: botUser?.id,
      username: botUser?.username,
      discriminator: botUser?.discriminator,
      guildName: guild?.name || 'Unknown Guild'
    };
    
    console.log('Discord token validation successful:', botInfo);
    
    return {
      valid: true,
      botInfo
    };
    
  } catch (error) {
    console.error('Discord token validation failed:', error);
    
    let errorMessage = 'Invalid Discord bot token';
    if (error.message.includes('TOKEN_INVALID')) {
      errorMessage = 'Invalid Discord bot token. Please check your token.';
    } else if (error.message.includes('timeout')) {
      errorMessage = 'Discord connection timeout. Please try again.';
    } else if (error.message.includes('MISSING_PERMISSIONS')) {
      errorMessage = 'Bot is missing required permissions in the Discord server.';
    } else if (error.message) {
      errorMessage = error.message;
    }
    
    return {
      valid: false,
      error: errorMessage
    };
  } finally {
    // Always destroy the test client
    if (client) {
      try {
        client.destroy();
        console.log('Test Discord client destroyed');
      } catch (destroyError) {
        console.error('Error destroying test client:', destroyError);
      }
    }
  }
}

// Validate if user has admin access to a space (creator or admin group member)
async function validateSpaceAdmin(spaceId: string, userId: string): Promise<boolean> {
  try {
    console.log('Validating admin access for user', userId, 'on space', spaceId);
    
    // Load the space
    const space = await Space.load(spaceId);
    if (!space) {
      console.log('Space not found:', spaceId);
      return false;
    }
    
    console.log('Space loaded:', space.name, 'creator:', space.creatorId);
    
    // Check if user is the space creator
    if (space.creatorId === userId) {
      console.log('User is space creator - access granted');
      return true;
    }
    
    // Check if user is in the admin group
    if (space.adminGroupId) {
      try {
        const adminGroup = await Group.load(space.adminGroupId);
        if (adminGroup) {
          console.log('Admin group loaded:', space.adminGroupId);
          
          // Check if the user's account is the owner of the admin group
          // or has write access to it (indicating admin membership)
          try {
            // Load the user's account to check permissions
            const userAccount = await Account.load(userId);
            if (userAccount) {
                // TODO: Check if userAccount has write access to the admin group
                return true;
            }
          } catch (userError) {
            console.log('Could not load user account:', userError.message);
          }
        }
      } catch (error) {
        console.error('Error loading admin group:', error);
      }
    }
    
    console.log('User does not have admin access');
    return false;
  } catch (error) {
    console.error('Error validating space admin access:', error);
    return false;
  }
}

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
  const { activeBridges: activeCount, bridges } = getBridgeStatus();
  res.json({
    activeBridges: activeCount,
    bridgeIds: bridges,
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage()
  });
});

// Test Discord token endpoint
app.post('/validate-discord', (req, res) => {
  (async () => {
    try {
      const { discordToken, guildId } = req.body;
      
      if (!discordToken || !guildId) {
        return res.status(400).json({ 
          error: 'Missing required fields: discordToken, guildId' 
        });
      }
      
      const validation = await validateDiscordToken(discordToken, guildId);
      
      if (validation.valid) {
        res.json({
          valid: true,
          message: 'Discord token and guild access validated successfully',
          botInfo: validation.botInfo
        });
      } else {
        res.status(400).json({
          valid: false,
          error: validation.error
        });
      }
    } catch (error) {
      console.error('Error validating Discord token:', error);
      res.status(500).json({ 
        valid: false,
        error: 'Internal error during validation',
        details: error.message 
      });
    }
  })();
});

// Start a bridge
app.post('/bridges', (req, res) => {
  (async () => {
    try {
        console.log('Received request to start bridge:', req.body);
      const { id, spaceId, channelId, guildId, discordToken, name, userId } = req.body;
      
      if (!id || !spaceId || !channelId || !guildId || !discordToken || !userId) {
        return res.status(400).json({ 
          error: 'Missing required fields: id, spaceId, channelId, guildId, discordToken, userId' 
        });
      }
      
      console.log(`Creating bridge: ${name} for user ${userId} on space ${spaceId}`);
      
      const discordValidation = await validateDiscordToken(discordToken, guildId);
      if (!discordValidation.valid) {
        return res.status(400).json({ 
          error: 'Discord validation failed',
          details: discordValidation.error
        });
      }
      
      console.log('Discord token validated successfully:', discordValidation.botInfo);
      
      const hasAdminAccess = await validateSpaceAdmin(spaceId, userId);
      if (!hasAdminAccess) {
        return res.status(403).json({ 
          error: 'Access denied: Only space admins or creators can create bridges' 
        });
      }
      
      console.log('Admin access validated successfully');
    
      const result = await startBridge(spaceId, channelId, guildId, discordToken);
      
      res.json({ 
        success: true, 
        message: `Bridge ${name || id} started successfully`,
        bridgeId: id,
        bridgeKey: result.bridgeKey,
        botInfo: discordValidation.botInfo
      });
    } catch (error) {
      console.error('Error starting bridge:', error);
      res.status(500).json({ 
        error: 'Failed to start bridge', 
        details: error.message 
      });
    }
  })();
});

// Stop a bridge
app.delete('/bridges/:id', (req, res) => {
  (async () => {
    try {
      const { id } = req.params;
      
      await stopBridge(id);
      
      res.json({ 
        success: true, 
        message: `Bridge ${id} stopped successfully` 
      });
    } catch (error) {
      console.error('Error stopping bridge:', error);
      res.status(500).json({ 
        error: 'Failed to stop bridge', 
        details: error.message 
      });
    }
  })();
});

// Get all bridges
app.get('/bridges', (req, res) => {
  const { activeBridges: activeCount, bridges } = getBridgeStatus();
  res.json({
    bridges: bridges.map(id => ({
      id,
      status: 'active'
    })),
    totalActive: activeCount
  });
});

let worker: any;
let admin: Group | undefined;

async function initializeJazz() {
  try {
    console.log('Initializing Jazz worker...');
    
    const accountID = process.env.JAZZ_WORKER_ACCOUNT;
    const accountSecret = process.env.JAZZ_WORKER_SECRET;
    const syncServer = `wss://cloud.jazz.tools/?key=${process.env.JAZZ_API_KEY}`;
    
    if (!accountID || !accountSecret) {
      throw new Error('Jazz credentials not set in environment variables: JAZZ_WORKER_ACCOUNT, JAZZ_WORKER_SECRET');
    }
    
    const { worker: jazzWorker } = await startWorker({
      AccountSchema: RoomyAccount,
      accountID,
      accountSecret,
      syncServer,
    });
      worker = jazzWorker;
    admin = jazzWorker.root._owner as Group;
    console.log('Jazz worker initialized successfully with account:', accountID);
    
    // Start monitoring for bridge configurations
    await monitorBridgeConfigs();
    
  } catch (error) {
    console.error('Failed to initialize Jazz worker:', error);
    process.exit(1);
  }
}

async function monitorBridgeConfigs() {
  if (!admin) {
    console.error('Admin group not available');
    return;
  }

  console.log('Starting to monitor for bridge configurations...');
  
  // Here we'll listen for bridge configuration changes from the main Roomy app
  // This will be implemented when we add the bridge config schema
  setInterval(async () => {
    try {
      // Poll for new bridge configurations
      // This is a placeholder - in a real implementation, we'd use Jazz subscriptions
      console.log('Monitoring for bridge configurations...');
    } catch (error) {
      console.error('Error monitoring bridge configs:', error);
    }
  }, 10000); // Check every 10 seconds
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down Discord Bridge server...');
  if (worker) {
    worker.destroy?.();
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Shutting down Discord Bridge server...');
  if (worker) {
    worker.destroy?.();
  }
  process.exit(0);
});

// Start the server
app.listen(PORT, () => {
  console.log(`Discord Bridge server running on port ${PORT}`);
  console.log(`Health check available at http://localhost:${PORT}/health`);
  
  // Initialize Jazz after server starts
  initializeJazz();
});

export { app, worker, admin };
