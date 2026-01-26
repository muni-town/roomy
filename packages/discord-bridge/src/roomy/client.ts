/**
 * Roomy client for the Discord bridge.
 *
 * Authenticates using app password and creates a RoomyClient instance
 * for interacting with ATProto and Leaf.
 */

import { AtpAgent } from "@atproto/api";
import {
  RoomyClient,
  ConnectedSpace,
  modules,
  type StreamDid,
  type StreamIndex,
} from "@roomy/sdk";
import {
  ATPROTO_BRIDGE_DID,
  ATPROTO_BRIDGE_APP_PASSWORD,
  LEAF_URL,
  LEAF_SERVER_DID,
  STREAM_HANDLE_NSID,
  STREAM_NSID,
} from "../env.js";
import { registeredBridges } from "../db.js";
import {
  createSpaceSubscriptionHandler,
  getLastProcessedIdx,
} from "./subscription.js";
import { tracer, setRoomyAttrs, recordError } from "../tracing.js";

let roomyClient: RoomyClient | undefined;

/**
 * Initialize the Roomy client using app password authentication.
 * This should be called once at startup.
 */
export async function initRoomyClient(): Promise<RoomyClient> {
  if (roomyClient) {
    return roomyClient;
  }

  console.log("Authenticating with ATProto...");
  const atpAgent = new AtpAgent({ service: "https://bsky.social" });

  await atpAgent.login({
    identifier: ATPROTO_BRIDGE_DID,
    password: ATPROTO_BRIDGE_APP_PASSWORD,
  });

  if (!atpAgent.did) {
    throw new Error("Failed to authenticate with app password - no DID");
  }

  console.log(`Authenticated as ${atpAgent.did}`);
  console.log("Connecting to Leaf server...");

  roomyClient = await RoomyClient.create(
    {
      agent: atpAgent,
      leafUrl: LEAF_URL,
      leafDid: LEAF_SERVER_DID,
      spaceHandleNsid: STREAM_HANDLE_NSID,
      spaceNsid: STREAM_NSID,
    },
    {
      onConnect: () => console.log("Leaf: connected"),
      onDisconnect: () => console.log("Leaf: disconnected"),
    },
  );

  // Connect to the bridge's personal stream
  console.log("Connecting to personal stream...");
  await roomyClient.connectPersonalSpace("4");
  console.log("Personal stream connected");

  console.log("Roomy client initialized successfully");
  return roomyClient;
}

/**
 * Get the initialized Roomy client.
 * Throws if client hasn't been initialized yet.
 */
export function getRoomyClient(): RoomyClient {
  if (!roomyClient) {
    throw new Error(
      "Roomy client not initialized - call initRoomyClient first",
    );
  }
  return roomyClient;
}

/**
 * Get the bridge's DID.
 */
export function getBridgeDid(): string {
  return getRoomyClient().agent.assertDid;
}

/** Map of connected spaces by spaceId */
const connectedSpaces = new Map<string, ConnectedSpace>();

/**
 * Subscribe to all registered spaces, resuming from stored cursors.
 * This should be called once at startup after initRoomyClient().
 */
export async function subscribeToConnectedSpaces(): Promise<void> {
  const client = getRoomyClient();
  const bridges = await registeredBridges.list();

  console.log(`Subscribing to ${bridges.length} connected spaces...`);

  for (const { spaceId } of bridges) {
    try {
      await subscribeToSpace(client, spaceId as StreamDid);
    } catch (e) {
      console.error(`Failed to subscribe to space ${spaceId}:`, e);
    }
  }

  console.log("All space subscriptions started");
}

/**
 * Subscribe to a single space, resuming from stored cursor.
 */
export async function subscribeToSpace(
  client: RoomyClient,
  spaceId: StreamDid,
): Promise<ConnectedSpace> {
  return tracer.startActiveSpan(
    "leaf.stream.subscribe",
    { attributes: { "roomy.space.id": spaceId } },
    async (span) => {
      try {
        // Check if already connected
        const existing = connectedSpaces.get(spaceId);
        if (existing) {
          console.log(`Already subscribed to space ${spaceId}`);
          span.setAttribute("subscription.status", "already_connected");
          return existing;
        }

        console.log(`Connecting to space ${spaceId}...`);

        // Connect to the space
        const space = await tracer.startActiveSpan(
          "leaf.stream.connect",
          async (connectSpan) => {
            try {
              const s = await ConnectedSpace.connect({
                client,
                streamDid: spaceId,
                module: modules.space,
              });
              connectSpan.setAttribute("connection.status", "success");
              return s;
            } catch (e) {
              recordError(connectSpan, e);
              throw e;
            } finally {
              connectSpan.end();
            }
          },
        );

        // Get the cursor to resume from
        const cursor = await getLastProcessedIdx(spaceId);
        console.log(`Resuming space ${spaceId} from idx ${cursor}`);
        span.setAttribute("subscription.resume_cursor", cursor ?? "none");

        // Subscribe with the handler
        const handler = createSpaceSubscriptionHandler(spaceId);
        space.subscribe(handler, cursor as StreamIndex);

        // Wait for backfill to complete before returning
        console.log(`Waiting for backfill of space ${spaceId}...`);
        await tracer.startActiveSpan("leaf.stream.backfill", async (backfillSpan) => {
          try {
            setRoomyAttrs(backfillSpan, { spaceId });
            await space.doneBackfilling;
            backfillSpan.setAttribute("backfill.status", "complete");
          } catch (e) {
            recordError(backfillSpan, e);
            throw e;
          } finally {
            backfillSpan.end();
          }
        });
        console.log(`Backfill complete for space ${spaceId}`);

        connectedSpaces.set(spaceId, space);
        console.log(`Subscribed to space ${spaceId}`);
        span.setAttribute("subscription.status", "connected");

        return space;
      } catch (e) {
        recordError(span, e);
        throw e;
      } finally {
        span.end();
      }
    },
  );
}

/**
 * Get a connected space by ID, if subscribed.
 */
export function getConnectedSpace(spaceId: string): ConnectedSpace | undefined {
  return connectedSpaces.get(spaceId);
}
