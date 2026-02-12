/**
 * Roomy client for the Discord bridge.
 *
 * Authenticates using app password and creates a RoomyClient instance
 * for interacting with ATProto and Leaf.
 */

import { AtpAgent } from "@atproto/api";
import { RoomyClient } from "@roomy/sdk";
import {
  ATPROTO_BRIDGE_DID,
  ATPROTO_BRIDGE_APP_PASSWORD,
  LEAF_URL,
  LEAF_SERVER_DID,
  STREAM_HANDLE_NSID,
  STREAM_NSID,
} from "../env.js";
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
