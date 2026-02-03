/**
 * The peer worker.
 * 
 * On some platforms or in some situations this is a shared worker while on others it is a dedicated
 * worker.
 * 
 * NOTE: SharedWorker logs are not accessible in all browsers.
 *
 * For Chrome, go to chrome://inspect/#workers and click 'inspect' under roomy-peer For browsers
 * that don't have this feature, call this.debugWorkers.enableLogForwarding() from the main thread
 * to see worker logs there
 * */

/* eslint-disable @typescript-eslint/no-explicit-any */
/// <reference lib="webworker" />

import {
  newUlid,
} from "@roomy/sdk";
import { Peer } from "./impl";
import { initializeFaro } from "$lib/otel";

/**
 * The peer worker is where the OAuth session is held and, significantly, where the leaf client
 * and ATProto session are managed, so the peer is responsible for creating the session ID. When
 * using a shared worker this will persist across tabs.
 * */

/**
 * The peer worker is where the OAuth session is held and, significantly, where the leaf client
 * and ATProto session are managed, so the peer is responsible for creating the session ID. When
 * using a shared worker this will persist across tabs.
 * */
const sessionId = newUlid();

// Initialize the faro agent for this worker.
initializeFaro({ worker: "peer" });
// Set the session ID to our generated session ID.
faro.api.setSession({ id: sessionId, attributes: { isSampled: "true" } });

/**
 * Check whether or not we are executing in a shared worker.
 *
 * On platforms like Android chrome where SharedWorkers are not available this script will run as a
 * dedicated worker instead of a shared worker.
 * */
const isSharedWorker = "SharedWorkerGlobalScope" in globalThis;

/**
 * Create the peer worker.
 * 
 * This class wraps up all the peer logic.
 * */
const peer = new Peer({ sessionId });

// If we are running as a shared worker
if (isSharedWorker) {
  // We need to register an on-connect handler that will connect the RPC message port for any tab
  // that opens to the peer worker class.
  (globalThis as any).onconnect = async ({
    ports: [port],
  }: {
    ports: [MessagePort];
  }) => {
    peer.connectRpcMessagePort(port);
  };

} else {
  // If we are running as a dedicated worker, then we will only have one message port for the
  // current tab, and that is located on `globalThis`.
  peer.connectRpcMessagePort(globalThis);
}

(globalThis as any).peer = peer; // For debugging only !!
