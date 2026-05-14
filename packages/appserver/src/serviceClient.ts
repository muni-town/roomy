/**
 * Lazy singleton RoomyServiceClient + per-space ConnectedSpace cache.
 *
 * The Leaf server (and the static unsafe-auth token) are not required at
 * startup — we only construct the client on first use so the appserver can
 * boot without Leaf being reachable.
 */

import {
  RoomyServiceClient,
  ConnectedSpace,
  modules,
  StreamDid,
} from "@roomy-space/sdk";

const LEAF_URL = process.env.LEAF_URL ?? "https://leaf-dev.muni.town";
const LEAF_DID =
  process.env.LEAF_SERVER_DID ?? `did:web:${new URL(LEAF_URL).hostname}`;
const UNSAFE_AUTH_TOKEN = process.env.LEAF_UNSAFE_AUTH_TOKEN;

let clientPromise: Promise<RoomyServiceClient> | null = null;
const spaces = new Map<string, Promise<ConnectedSpace>>();

export function getServiceClient(): Promise<RoomyServiceClient> {
  if (clientPromise) return clientPromise;
  if (!UNSAFE_AUTH_TOKEN) {
    return Promise.reject(
      new Error(
        "LEAF_UNSAFE_AUTH_TOKEN is not set; cannot create RoomyServiceClient",
      ),
    );
  }

  console.log("Client env:", { UNSAFE_AUTH_TOKEN, LEAF_DID });
  clientPromise = RoomyServiceClient.create({
    leafUrl: LEAF_URL,
    leafDid: LEAF_DID,
    unsafeAuthToken: UNSAFE_AUTH_TOKEN,
  }).catch((err) => {
    // Reset so the next caller can retry
    clientPromise = null;
    throw err;
  });
  return clientPromise;
}

export function getConnectedSpace(
  streamDid: StreamDid,
): Promise<ConnectedSpace> {
  const cached = spaces.get(streamDid);
  if (cached) return cached;
  const promise = (async () => {
    const client = await getServiceClient();
    return client.connectSpace(streamDid, modules.space);
  })().catch((err) => {
    spaces.delete(streamDid);
    throw err;
  });
  spaces.set(streamDid, promise);
  return promise;
}
