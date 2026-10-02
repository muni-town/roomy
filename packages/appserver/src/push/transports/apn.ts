/**
 * APNs transport (iOS / iPadOS / macOS) over the HTTP/2 provider API.
 *
 * Apple's provider API is an HTTP/2 POST to `/3/device/<token>` that carries
 * a provider JWT (`authorization: bearer …`, ES256 over the `.p8` auth key).
 * `apns-topic` is the app bundle id; `apns-collapse-id` coalesces a room's
 * notifications the way the Web Push `Topic` header does.
 *
 * The visible text is built here rather than on the client: when the app is
 * not running, iOS displays `aps.alert` from the payload alone, so a payload
 * carrying only room/message ids would arrive as an empty notification.
 * `notificationText` (the renderer the service worker also uses) supplies the
 * same title/body a browser push would show, and the raw payload rides along
 * as a top-level `roomy` key so a running client can still deep-link. That key
 * is a JSON *string*, not a nested object: the client plugin projects
 * `userInfo` to JS by copying only String and NSNumber values, so a dictionary
 * would be dropped before the webview saw it. A custom key must also be a peer
 * of `aps`, never a child — APNs ignores unknown keys inside `aps`.
 *
 * Outcome mapping follows Apple's documented prune/retry split: a token that
 * is no longer valid for the topic (`410`, `400 BadDeviceToken` /
 * `DeviceTokenNotForTopic`) is `gone` and the dispatcher prunes the row;
 * `429`/`5xx`/network are `retry`. A `400` this transport caused (a malformed
 * request — our bug) is also `retry`, never `gone`, which would delete a
 * healthy device because we sent something wrong.
 */

import http2 from "node:http2";
import { notificationText } from "@roomy-space/sdk/push";
import { log } from "../../log.ts";
import type { PushPayload } from "../types.ts";
import { importSigningKey, pemToDer, signJwt } from "./jwt.ts";
import {
  PUSH_TRANSPORTS,
  type PushDeliveryOptions,
  type PushOutcome,
  type PushTransport,
  type PushTarget,
} from "./types.ts";

export interface ApnsConfig {
  /**
   * The APNs auth key (`.p8`). PKCS#8 PEM, or that PEM base64-encoded with
   * escaped newlines — a single-line secret store value is the common case.
   */
  key: string;
  /** The 10-character key id, sent as the JWT `kid` header. */
  keyId: string;
  /** The 10-character team id, sent as the JWT `iss` claim. */
  teamId: string;
  /** The app's bundle id; APNs rejects a push whose topic does not match. */
  topic: string;
  /** `api.push.apple.com` (default) or `api.sandbox.push.apple.com`. */
  host: string;
  port?: number;
}

/** Reasons meaning this device token can never be delivered to again. */
const PRUNE_REASONS: Record<string, true> = {
  BadDeviceToken: true,
  DeviceTokenNotForTopic: true,
  Unregistered: true,
  ExpiredToken: true,
  Forbidden: true,
};

/**
 * Provider tokens are valid for at most an hour, and Apple rejects a token
 * refreshed more often than every 20 minutes, so one is minted per ~50
 * minutes: inside the validity window, outside the refresh-rate floor.
 */
const TOKEN_TTL_MS = 50 * 60 * 1000;

/**
 * Build an APNs transport. A factory rather than a module-level singleton so
 * the credential set and the endpoint are explicit: a test points `host` at a
 * local HTTP/2 server and asserts the wire request, which a module reading
 * `process.env` at import could not be made to do.
 */
export function createApnsTransport(config: ApnsConfig): PushTransport {
  const authority = config.port ? `${config.host}:${config.port}` : config.host;
  const scheme = config.port ? "http" : "https";
  const origin = `${scheme}://${authority}`;

  let cachedKey: CryptoKey | null = null;
  let token: { value: string; expiresAt: number } | null = null;
  let session: http2.ClientHttp2Session | null = null;

  /**
   * Decode the auth key. `.p8` content is PEM, but a secret store commonly
   * carries it base64-encoded, and a single-line environment value escapes
   * its newlines; accept all three.
   */
  function authKeyDer(): Uint8Array<ArrayBuffer> {
    const raw = config.key.includes("\\n")
      ? config.key.replace(/\\n/g, "\n")
      : config.key;
    if (raw.includes("-----BEGIN")) return pemToDer(raw);
    // A secret store may carry the PEM base64-encoded. The decode must land on
    // PEM, or a wrong value would sail past `isConfigured` and surface as a
    // signing failure on every push instead of a configuration error.
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    if (!decoded.includes("-----BEGIN")) {
      throw new Error("APNs auth key is neither PEM nor base64-encoded PEM");
    }
    return pemToDer(decoded);
  }

  async function providerToken(): Promise<string> {
    const now = Date.now();
    if (token && token.expiresAt > now) return token.value;
    // A new token needs the key; import it once and keep it for the process.
    if (!cachedKey) cachedKey = await importSigningKey("ES256", authKeyDer());
    const value = await signJwt(
      "ES256",
      cachedKey,
      { alg: "ES256", kid: config.keyId },
      // Apple's provider token has no `aud` or `exp`: validity is bounded by
      // how old `iat` is, and the `kid` header is what names the key.
      { iss: config.teamId, iat: Math.floor(now / 1000) },
    );
    token = { value, expiresAt: now + TOKEN_TTL_MS };
    return value;
  }

  /**
   * A live HTTP/2 session, reused across deliveries — a session per push would
   * pay a TLS handshake every time. The cache is dropped when the session ends
   * or errors so the next delivery dials fresh instead of writing to a dead
   * socket.
   */
  function apnsSession(): http2.ClientHttp2Session {
    if (session && !session.closed && !session.destroyed) return session;
    const next = http2.connect(origin);
    next.on("error", (err) => {
      log.warn(`[push-apns] session error: ${err.message}`);
      if (session === next) session = null;
    });
    next.on("close", () => {
      if (session === next) session = null;
    });
    session = next;
    return next;
  }

  /** One HTTP/2 request. Resolves with the status and the reported reason. */
  async function post(
    path: string,
    headers: Record<string, string>,
    body: string,
  ): Promise<{ status: number | null; reason: string }> {
    const client = apnsSession();
    const { promise, resolve, reject } =
      Promise.withResolvers<{ status: number | null; reason: string }>();
    const req = client.request({ ":method": "POST", ":path": path, ...headers });
    // null until a response line arrives: a network failure has no status to
    // report, and reporting a 0 would read as a real response code.
    let status: number | null = null;
    let text = "";
    req.on("response", (h) => {
      status = Number(h[":status"] ?? 0);
    });
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      text += chunk;
    });
    req.on("error", reject);
    req.on("end", () => {
      // Apple sends `{"reason":"…"}` on failure and an empty body on 200.
      let reason = "";
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed === "object" && parsed !== null && "reason" in parsed) {
          const { reason: value } = parsed;
          if (typeof value === "string") reason = value;
        }
      } catch {
        // No body, or not JSON — `status` alone still classifies the result.
      }
      resolve({ status, reason });
    });
    req.end(body);
    return promise;
  }

  /** Delivery hints → the headers APNs reads them from. */
  function apnsHeaders(
    options: PushDeliveryOptions,
    bearer: string,
  ): Record<string, string> {
    return {
      authorization: `bearer ${bearer}`,
      "apns-topic": config.topic,
      // A user-visible alert, so `alert`; priority 10 delivers it now rather
      // than deferring for power (Apple requires 5 for `background`).
      "apns-push-type": "alert",
      "apns-priority": "10",
      // ≤64 bytes, per Apple. The dispatcher's room topic is 32.
      ...(options.topic ? { "apns-collapse-id": options.topic } : {}),
      ...(options.ttl
        ? { "apns-expiration": String(Math.floor(Date.now() / 1000) + options.ttl) }
        : {}),
    };
  }

  return {
    kind: "apns",
    isConfigured: () => {
      // Credentials must be present *and* usable: a malformed or wrong-type
      // key cannot sign, so reporting it as configured would claim a delivery
      // path that always throws.
      if (!config.key || !config.keyId || !config.teamId) return false;
      try {
        authKeyDer();
        return true;
      } catch {
        return false;
      }
    },
    async deliver(
      target: PushTarget,
      body: string,
      options: PushDeliveryOptions,
    ): Promise<PushOutcome> {
      if (!config.key || !config.keyId || !config.teamId) {
        return { outcome: "skipped", status: null };
      }

      let alert: { title: string; body: string };
      try {
        alert = notificationText(JSON.parse(body) as PushPayload);
      } catch (error) {
        // Our own payload would not parse. A retry cannot fix it, but pruning
        // the device would be worse and the seam has no third "never"
        // outcome, so count it failed and let the bug surface.
        return { outcome: "retry", status: null, error };
      }

      const requestBody = JSON.stringify({
        aps: {
          alert: { title: alert.title, body: alert.body },
          sound: "default",
          // A room's notifications replace each other on the lock screen, the
          // same coalescing `apns-collapse-id` applies at the service.
          ...(options.topic ? { "thread-id": options.topic } : {}),
        },
        roomy: body,
      });

      try {
        const bearer = await providerToken();
        const { status, reason } = await post(
          `/3/device/${target.endpoint}`,
          apnsHeaders(options, bearer),
          requestBody,
        );
        if (status === 200) return { outcome: "delivered", status };
        if (status === 410 || PRUNE_REASONS[reason] === true) {
          log.info(`[push-apns] token rejected (${status} ${reason}) — pruning`);
          return { outcome: "gone", status };
        }
        if (status === 403 && reason === "ExpiredProviderToken") {
          // The cached provider token outlived its hour: mint a new one and
          // report a retry, since the device itself is fine.
          token = null;
        }
        return {
          outcome: "retry",
          status,
          error: new Error(reason || `HTTP ${status}`),
        };
      } catch (error) {
        // Network/stream failure: drop the session so the next attempt dials
        // again rather than reusing a broken socket.
        session = null;
        return { outcome: "retry", status: null, error };
      }
    },
  };
}

/** The transport named by `APNS_*`, registered at import. */
PUSH_TRANSPORTS.apns = createApnsTransport({
  key: process.env.APNS_AUTH_KEY ?? "",
  keyId: process.env.APNS_KEY_ID ?? "",
  teamId: process.env.APNS_TEAM_ID ?? "",
  topic: process.env.APNS_TOPIC ?? "space.roomy",
  host:
    process.env.APNS_HOST ??
    (process.env.APNS_ENVIRONMENT === "sandbox"
      ? "api.sandbox.push.apple.com"
      : "api.push.apple.com"),
});
