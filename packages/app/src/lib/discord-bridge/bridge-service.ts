import {
  getBridgeStatus,
  sendMessageToDiscord,
  startBridge,
  stopBridge,
  testConnection,
} from "./websocket-bridge";
import toast from "svelte-french-toast";

// Channel mapping interface
export interface ChannelMapping {
  discordChannelId: string;
  discordChannelName: string;
  roomyChannelId: string;
  roomyChannelName: string;
}

// Bridge service state
let bridgeServiceInitialized = false;

// Main bridge service that can be imported anywhere in the app
export const discordBridgeService = {
  // Start the bridge with saved settings
  async initialize(): Promise<boolean> {
    if (bridgeServiceInitialized) return true;

    try {
      // Load saved bridge settings from localStorage
      const savedToken = localStorage.getItem("discord-bridge-token");
      const savedMappings = localStorage.getItem("discord-bridge-mappings");
      const savedStatus = localStorage.getItem("discord-bridge-status");

      if (savedToken && savedMappings && savedStatus) {
        const mappings = JSON.parse(savedMappings) as ChannelMapping[];
        const status = JSON.parse(savedStatus);

        // Only auto-start if bridge was previously active
        if (status.active && mappings.length > 0) {
          console.log("Auto-starting Discord bridge...");
          const success = await startBridge(savedToken, mappings);

          if (success) {
            console.log("Discord bridge auto-started successfully");
            bridgeServiceInitialized = true;
            return true;
          } else {
            console.error("Failed to auto-start Discord bridge");
          }
        }
      }
    } catch (error) {
      console.error("Error initializing Discord bridge:", error);
    }

    return false;
  },

  // Start bridge with specific token and mappings
  async start(token: string, mappings: ChannelMapping[]): Promise<boolean> {
    try {
      const success = await startBridge(token, mappings);

      if (success) {
        const status = {
          active: true,
          startedAt: new Date(),
        };

        // Save settings for future auto-start
        localStorage.setItem("discord-bridge-token", token);
        localStorage.setItem(
          "discord-bridge-mappings",
          JSON.stringify(mappings),
        );
        localStorage.setItem("discord-bridge-status", JSON.stringify(status));

        toast.success("Discord-Roomy bridge started successfully");
        bridgeServiceInitialized = true;
        return true;
      } else {
        toast.error("Failed to establish Discord-Roomy bridge");
        return false;
      }
    } catch (error) {
      console.error(error);
      toast.error("Error starting Discord bridge");
      return false;
    }
  },

  // Stop the bridge
  async stop(): Promise<boolean> {
    try {
      const stopped = stopBridge();

      if (stopped) {
        const status = {
          active: false,
          startedAt: null,
        };

        localStorage.setItem("discord-bridge-status", JSON.stringify(status));
        toast.success("Discord-Roomy bridge stopped");
        bridgeServiceInitialized = false;
        return true;
      } else {
        toast.error("No active bridge to stop");
        return false;
      }
    } catch (error) {
      console.error(error);
      toast.error("Error stopping Discord bridge");
      return false;
    }
  },

  // Test bridge connection
  async testConnection(): Promise<string> {
    return testConnection();
  },

  // Get current bridge status
  getBridgeStatus,

  // Send message to Discord
  sendMessageToDiscord,
};
