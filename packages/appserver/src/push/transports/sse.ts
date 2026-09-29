/**
 * Server-Sent Events transport, not yet implemented.
 *
 * Draft registration for a device that holds a connection to the appserver
 * rather than registering with a push service — a desktop shell, or a browser
 * tab with an open stream. There is no push-service endpoint to POST to and no
 * device token: the destination is a live connection this appserver owns.
 *
 * It answers `skipped` for every row while that connection registry does not
 * exist, so a stored `sse` row is counted as "a transport declined" and left in
 * place. It must never answer `gone` — a connected device is by definition
 * reachable, and pruning the row would be the opposite of the truth.
 *
 * When built, delivery writes to the connection's response stream and the
 * outcome is local rather than a remote status: an endpoint with no open
 * connection is `skipped` (the device is simply not open right now, which is
 * not a failure), and a write error is `retry`.
 */

import {
  PUSH_TRANSPORTS,
  type PushDeliveryOptions,
  type PushOutcome,
  type PushTransport,
  type PushTarget,
} from "./types.ts";

const sseTransport: PushTransport = {
  kind: "sse",
  // Nothing to configure until the connection registry exists.
  isConfigured: () => false,
  async deliver(
    _target: PushTarget,
    _body: string,
    _options: PushDeliveryOptions,
  ): Promise<PushOutcome> {
    return { outcome: "skipped", status: null };
  },
};

PUSH_TRANSPORTS[sseTransport.kind] = sseTransport;
