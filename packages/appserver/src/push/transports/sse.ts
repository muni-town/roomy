/**
 * Server-Sent Events transport.
 *
 * SSE connection happens in two phases. The client application calls
 * `space.roomy.push.registerSubscription` with its usual JWT and a client id.
 * That creates a row in `push_subscriptions`, uniquely tied to one client
 * application, exactly as for every other transport. To start receiving push
 * events, a second request goes to `space.roomy.push.stream`, which checks for
 * that registration and returns an event-stream response. This keeps
 * subscription management in the same schema as other transports while
 * opening one new channel needed for a stream.
 *
 * Delivery is a write to the open connection for that row's endpoint; there is nothing to POST to.
 *
 * The in-memory registry below is keyed by endpoint. a stream can only be
 * opened for an endpoint the caller has their own row for (see
 * `handlers/space.roomy.push.stream.ts`).
 *
 * Delivery is at-most-once and stateless: a registered device with no open
 * stream gets nothing queued. The registry is per process, which is why
 * streams are accepted only on the replica holding the dispatcher lease.
 *
 * Outcomes:
 *  - no open connection, or one that is closed or too far behind to take the
 *    frame → `skipped` (the device is not listening right now; it reconnects
 *    on its own);
 *  - never `gone`: an offline device is not a dead one, and pruning its row
 *    would unregister it;
 *  - `retry` only for a body that cannot be framed safely.
 */

import { log } from "../../log.ts";
import {
  PUSH_TRANSPORTS,
  type PushDeliveryOptions,
  type PushOutcome,
  type PushTarget,
  type PushTransport,
} from "./types.ts";

/** What a connection reports for one attempted write. */
export type SseWriteResult = "written" | "closed" | "backlogged";

/**
 * One open stream as the registry and transport see it. The HTTP plumbing
 * (response body, timers) lives in `push/sseStream.ts`; this interface is the
 * seam that keeps the transport testable without a socket.
 */
export interface SseConnection {
  readonly endpoint: string;
  /** Write one complete SSE frame. A backlogged connection closes itself. */
  send(frame: string): SseWriteResult;
  close(reason: string): void;
}

/** One connection per endpoint: a reconnect replaces its predecessor. */
const connectionsByEndpoint = new Map<string, SseConnection>();

/**
 * Make `connection` the live stream for its endpoint. A previous stream for
 * the same endpoint is closed: after a network change the old socket is
 * usually half-open, and keeping both would deliver every message twice.
 */
export function registerSseConnection(connection: SseConnection): void {
  const previous = connectionsByEndpoint.get(connection.endpoint);
  connectionsByEndpoint.set(connection.endpoint, connection);
  if (previous !== undefined && previous !== connection) {
    previous.close("replaced-by-reconnect");
  }
}

/**
 * Remove `connection` if it is still the registered one. Identity matters: a
 * replaced stream finishing late must not evict the stream that replaced it.
 */
export function unregisterSseConnection(connection: SseConnection): void {
  if (connectionsByEndpoint.get(connection.endpoint) === connection) {
    connectionsByEndpoint.delete(connection.endpoint);
  }
}

/** Close the stream for `endpoint`, if any */
export function closeSseConnection(endpoint: string, reason: string) {
  connectionsByEndpoint.get(endpoint)?.close(reason);
}

/**
 * Frame a payload as one SSE event. `body` is `JSON.stringify` output, which
 * escapes line breaks, so it cannot contain the CR or LF that would end the
 * `data:` line and let a payload forge further events. Anything else is
 * refused rather than sanitised: a body that reaches here with a line break
 * is a bug upstream, and silently rewriting it would hide that.
 */
export function frameSseEvent(eventName: string, body: string): string | null {
  if (/[\r\n]/.test(body) || /[\r\n]/.test(eventName)) return null;
  return `event: ${eventName}\ndata: ${body}\n\n`;
}

const sseTransport: PushTransport = {
  kind: "sse",
  isConfigured: () => true,
  async deliver(
    target: PushTarget,
    body: string,
    _options: PushDeliveryOptions,
  ): Promise<PushOutcome> {
    const frame = frameSseEvent("push", body);
    if (frame === null) {
      return {
        outcome: "retry",
        status: null,
        error: new Error("sse: payload body contains a line break"),
      };
    }

    const connection = connectionsByEndpoint.get(target.endpoint);
    if (connection === undefined) return { outcome: "skipped", status: null };

    const result = connection.send(frame);
    if (result === "written") return { outcome: "delivered", status: null };

    log.debug(`[sse] dropped delivery result=${result}`);
    return { outcome: "skipped", status: null };
  },
};

PUSH_TRANSPORTS[sseTransport.kind] = sseTransport;
