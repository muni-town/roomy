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
import { registeredBridges } from "../repositories/LevelDBBridgeRepository.js";
import { tracer, setRoomyAttrs, recordError } from "../tracing.js";
import { SpanStatusCode } from "@opentelemetry/api";
import { STREAM_SCHEMA_VERSION } from "../constants.js";

/**
 * Initialize the Roomy client using app password authentication.
 * This should be called once at startup.
 */
export async function initRoomyClient(): Promise<RoomyClient> {
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

  const roomyClient = await RoomyClient.create(
    {
      agent: atpAgent,
      leafUrl: LEAF_URL,
      leafDid: LEAF_SERVER_DID,
      profileSpaceNsid: STREAM_HANDLE_NSID,
      spaceNsid: STREAM_NSID,
    },
    {
      onConnect: () => console.log("Leaf: connected"),
      onDisconnect: () => console.log("Leaf: disconnected"),
    },
  );

  // Connect to the bridge's personal stream // what is it doing?
  console.log("Connecting to personal stream...");
  await roomyClient.connectPersonalSpace(STREAM_SCHEMA_VERSION);
  console.log("Personal stream connected");

  console.log("Roomy client initialized successfully");
  return roomyClient;
}

/**
 * Subscribe to all registered spaces, resuming from stored cursors.
 * This should be called once at startup after initRoomyClient().
 *
 * If a space connection fails, logs an error to telemetry and continues
 * with other spaces rather than crashing.
 */
// export async function subscribeToConnectedSpaces(
//   client: RoomyClient,
// ): Promise<void> {
//   return tracer.startActiveSpan("bridge.spaces.subscribe_all", async (span) => {
//     try {
//       const bridges = await registeredBridges.list();

//       console.log(`Subscribing to ${bridges.length} connected spaces...`);
//       span.setAttribute("space.count", bridges.length);

//       let failureCount = 0;
//       for (const { spaceId } of bridges) {
//         try {
//           await subscribeToSpace(client, spaceId as StreamDid);
//         } catch (e) {
//           failureCount++;
//           console.error(`Failed to subscribe to space ${spaceId}:`, e);
//           // Record error on the span for telemetry
//           recordError(span, e);
//           span.addEvent("space.subscription_failed", {
//             "roomy.space.id": spaceId,
//           });
//         }
//       }

//       console.log("All space subscriptions started");
//       span.setAttribute("space.failures", failureCount);
//       if (failureCount > 0) {
//         span.setStatus({
//           code: SpanStatusCode.ERROR,
//           message: `${failureCount} space(s) failed to subscribe`,
//         });
//       }
//     } catch (e) {
//       recordError(span, e);
//       throw e;
//     } finally {
//       span.end();
//     }
//   });
// }
