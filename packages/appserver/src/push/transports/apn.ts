/**
 * APNs transport (iOS / iPadOS / macOS), not yet implemented.
 *
 * Draft registration. It answers `skipped` for every row, so a stored `apns`
 * device is counted as "a transport declined" rather than as a delivery or a
 * failure — the honest answer while there is no wire call here. It must never
 * answer `gone`: that prunes the row, and a device whose transport has not
 * shipped would then be unregistered for a reason that has nothing to do with
 * the device.
 *
 * The wire call, once built, is an HTTP/2 POST to
 * `https://api.push.apple.com/3/device/<token>` carrying:
 *
 *   - `authorization: bearer <jwt>` — an ES256 JWT signed with the `.p8` auth
 *     key (env: `APNS_AUTH_KEY`, `APNS_KEY_ID`, `APNS_TEAM_ID`)
 *   - `apns-topic` — the app bundle id
 *   - `apns-push-type` — `alert` for a user-visible push
 *   - `apns-priority` — from {@link PushDeliveryOptions.urgency}
 *   - `apns-collapse-id` — from {@link PushDeliveryOptions.topic}, so a room's
 *     notifications coalesce the way the Web Push `Topic` header does
 *
 * The body is the same JSON the Web Push transport sends, as an APS dictionary,
 * so the client's notification-decoding logic is shared across transports.
 * `410 Unregistered` and `400 BadDeviceToken` map to `gone`; `429`/`5xx`/network
 * map to `retry`. See `docs/plans/native-push-plan.md`.
 */

import {
  PUSH_TRANSPORTS,
  type PushDeliveryOptions,
  type PushOutcome,
  type PushTransport,
  type PushTarget,
} from "./types.ts";

const apnTransport: PushTransport = {
  kind: "apns",
  // Reads the credentials above and probes them against Apple once the wire
  // call exists. Env presence alone would report a transport that delivers
  // nothing as configured.
  isConfigured: () => false,
  async deliver(
    _target: PushTarget,
    _body: string,
    _options: PushDeliveryOptions,
  ): Promise<PushOutcome> {
    return { outcome: "skipped", status: null };
  },
};

PUSH_TRANSPORTS[apnTransport.kind] = apnTransport;
