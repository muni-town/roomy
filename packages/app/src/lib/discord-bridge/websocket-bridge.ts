import { globalState } from "$lib/global.svelte";
import { Channel, Message, type EntityIdStr } from "@roomy-chat/sdk";
import { io, Socket } from "socket.io-client";
import {
  PUBLIC_DISCORD_BRIDGE_URL,
  PUBLIC_DISCORD_BRIDGE_PORT,
} from "$env/static/public";

// Define types for socket.io client
interface ServerToClientEvents {
  bridgeStatus: (status: { success: boolean; message: string }) => void;
  messageStatus: (status: {
    direction: string;
    success: boolean;
    message: string;
  }) => void;
  discordMessage: (data: {
    content: string;
    author: {
      username: string;
      id: string;
      avatarUrl: string;
    };
    mapping: ChannelMapping;
    discordMessageId: string;
    timestamp: number;
  }) => void;
}

interface ClientToServerEvents {
  startBridge: (data: {
    discordToken: string;
    mappings: ChannelMapping[];
  }) => void;
  roomyMessage: (data: {
    content: string;
    mapping: ChannelMapping;
    author?: string;
    avatarUrl?: string;
  }) => void;
  stopBridge: () => void;
  testConnection: () => void;
}

// Define channel mapping type
interface ChannelMapping {
  discordChannelId: string;
  discordChannelName: string;
  roomyChannelId: string;
  roomyChannelName: string;
}

// Keep track of message IDs we've already processed to avoid loops
const processedMessages = new Set<string>();
let socket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;
let channelListeners = new Map<string, () => void>();

// Mapping cache to avoid repeated lookups
const channelMappings = new Map<string, ChannelMapping[]>();

// Store bridge status
let bridgeStatus = {
  active: false,
  startedAt: null as Date | null,
};

export function extractTextFromTipTap(node: any): string {
  if (!node) return "";

  if (node.text) return node.text;

  if (node.content && Array.isArray(node.content)) {
    return node.content.map(extractTextFromTipTap).join("");
  }

  return "";
}

export async function startBridge(
  discordToken: string,
  mappings: ChannelMapping[],
) {
  if (socket) {
    console.log("Bridge already started");
    return true;
  }

  // Connect to bridge server
  try {
    // Use environment variables with fallback values
    const bridgeUrl = PUBLIC_DISCORD_BRIDGE_URL || "http://localhost";
    const bridgePort = PUBLIC_DISCORD_BRIDGE_PORT || "3000";

    socket = io(`${bridgeUrl}:${bridgePort}`) as Socket<
      ServerToClientEvents,
      ClientToServerEvents
    >;

    // Setup socket connection
    socket.on("connect", () => {
      console.log("Connected to Discord bridge server");

      if (socket) {
        // Start the bridge with Discord
        socket.emit("startBridge", {
          discordToken,
          mappings,
        });

        // Store mappings for later use with direct sending
        channelMappings.set("current", mappings);

        // Set bridge status
        bridgeStatus.active = true;
        bridgeStatus.startedAt = new Date();
      }
    });

    // Handle bridge status messages
    socket.on(
      "bridgeStatus",
      (status: { success: boolean; message: string }) => {
        console.log("Bridge status:", status.message);
        if (!status.success) {
          console.error("Bridge error:", status.message);
          bridgeStatus.active = false;
        }
      },
    );

    // Handle message status updates
    socket.on(
      "messageStatus",
      (status: { direction: string; success: boolean; message: string }) => {
        console.log(`Message ${status.direction}: ${status.message}`);
      },
    );

    // Handle incoming Discord messages
    socket.on("discordMessage", async (data) => {
      if (!globalState.roomy) return;

      // Check if the message is already processed
      const messageId = `discord-${data.discordMessageId}`;
      if (processedMessages.has(messageId)) return;
      processedMessages.add(messageId);

      try {
        const channel = await globalState.roomy.open(
          Channel,
          data.mapping.roomyChannelId as EntityIdStr,
        );

        const message = await globalState.roomy.create(Message);

        message.bodyJson = JSON.stringify({
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: data.content,
                },
              ],
            },
          ],
        });

        const authorString = `discord:${data.author.username}:${encodeURIComponent(data.author.avatarUrl)}`;
        message.authors((x) => x.push(authorString));

        channel.timeline.push(message);

        message.commit();
        channel.commit();

        console.log(
          `[Discord → Roomy] Message from ${data.author.username} sent to ${data.mapping.roomyChannelName}`,
        );

        // Clean up after a delay
        setTimeout(() => {
          processedMessages.delete(messageId);
        }, 60000);
      } catch (error) {
        console.error("Error processing Discord message:", error);
      }
    });

    return true;
  } catch (error) {
    console.error("Error starting bridge:", error);
    bridgeStatus.active = false;
    return false;
  }
}

export function stopBridge(): boolean {
  if (!socket) return false;

  // Cleanup all listeners
  for (const unsubscribe of channelListeners.values()) {
    unsubscribe();
  }
  channelListeners.clear();

  // Clear mappings
  channelMappings.delete("current");

  // Reset bridge status
  bridgeStatus.active = false;
  bridgeStatus.startedAt = null;

  // Stop the bridge
  socket.emit("stopBridge");
  socket.disconnect();
  socket = null;
  return true;
}

export async function testConnection(): Promise<string> {
  if (!socket) {
    return "Bridge is not connected";
  }
  return socket.connected ? "Bridge is connected" : "Bridge is disconnected";
}

// Add this function to get bridge status
export function getBridgeStatus() {
  return {
    active: !!socket && socket.connected && bridgeStatus.active,
    startedAt: bridgeStatus.startedAt,
  };
}

// Send message directly to Discord
export async function sendMessageToDiscord(
  roomyChannelId: string,
  content: string,
  authorName: string,
  avatarUrl?: string,
): Promise<boolean> {
  if (!socket || !socket.connected) {
    console.warn("Discord bridge not connected");
    return false;
  }

  // Find mapping for this channel
  const mappings = channelMappings.get("current");
  if (!mappings) {
    console.warn("No channel mappings found");
    return false;
  }

  const mapping = mappings.find((m) => m.roomyChannelId === roomyChannelId);
  if (!mapping) {
    console.warn(`No mapping found for Roomy channel ${roomyChannelId}`);
    return false;
  }

  // Skip if empty content
  if (!content) return false;

  // Create a unique ID for this message to avoid loops
  const messageId = `roomy-direct-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  if (processedMessages.has(messageId)) return false;
  processedMessages.add(messageId);

  try {
    // Send message to Discord via bridge server with profile info
    socket.emit("roomyMessage", {
      content: content,
      mapping: mapping,
      author: authorName,
      avatarUrl: avatarUrl,
    });

    console.log(
      `[Roomy → Discord] Message from ${authorName} sent to ${mapping.discordChannelName}`,
    );

    // Clean up message ID after a delay
    setTimeout(() => {
      processedMessages.delete(messageId);
    }, 60000);

    return true;
  } catch (error) {
    console.error("Error sending message to Discord:", error);
    return false;
  }
}
