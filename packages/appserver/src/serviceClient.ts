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
  Event,
} from "@roomy-space/sdk";
import { encode, decode, BytesWrapper } from "@atcute/cbor";

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

/**
 * Send events directly through the Leaf WebSocket, bypassing ConnectedSpace.
 *
 * ConnectedSpace.connect() runs streamInfo, module CID computation, and
 * potentially module upload/update — all of which is unnecessary for sending
 * events. This function talks straight to the Leaf socket, which is already
 * authenticated and connected via the service client singleton.
 */
export async function sendEventsToStream(
  streamDid: StreamDid,
  events: (typeof Event.infer)[],
  userOverride?: string,
): Promise<void> {
  const client = await getServiceClient();

  const payload: Record<string, unknown> = {
    streamDid,
    events: events.map((event) => new BytesWrapper(encode(event))),
  };
  if (userOverride) {
    payload.userOverride = userOverride;
  }

  const encoded = encode(payload);
  const binary = Buffer.from(encoded);

  const respBytes = await (client.leaf as any).socket.emitWithAck(
    "stream/event_batch",
    binary,
  );
  const resp = decode(
    respBytes instanceof Uint8Array
      ? respBytes
      : new Uint8Array(respBytes),
  );
  if (
    resp &&
    typeof resp === "object" &&
    "Err" in (resp as Record<string, unknown>)
  ) {
    throw new Error((resp as { Err: string }).Err);
  }
}
