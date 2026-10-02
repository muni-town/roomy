/**
 * FCM transport (Android) over the HTTP v1 API.
 *
 * A send is a POST to `…/v1/projects/<project>/messages:send` authorised by an
 * OAuth2 bearer token minted from a service-account JSON: an RS256 assertion
 * to Google's token endpoint, exchanged for an access token that lives an
 * hour. Both the parsed account and the token are cached until the token is
 * near expiry.
 *
 * The visible text is built here, not on the client: Android does not display
 * a data-only message unless the app is running to handle it, so the payload
 * carries a `notification` block for the system tray as well as the raw Roomy
 * payload in `data`. `data` values must be strings, so the payload rides as a
 * JSON string under `roomy` for the client to parse. `collapse_key` coalesces
 * a room's notifications and belongs in the Android config — a `collapse_key`
 * inside `data` is a reserved key FCM overrides.
 *
 * Outcome mapping follows Google's documented split: an unregistered or
 * unknown token (`UNREGISTERED`/`NOT_FOUND`) is `gone`, so the dispatcher
 * prunes the row; `QUOTA_EXCEEDED`/`UNAVAILABLE`/`INTERNAL` and network
 * failures are `retry`; anything this transport caused — a bad request, a
 * mismatched sender, refused credentials — is also `retry`, never `gone`,
 * since the device may be perfectly valid.
 */

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

export interface FcmConfig {
  /** The service-account JSON, as stored. */
  serviceAccountJson: string;
  /** `fcm.googleapis.com` unless a test points at a local stub. */
  host: string;
  port?: number;
}

/** The service-account fields the OAuth2 flow needs. */
interface ServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
/** Google issues hour-long tokens; refresh with a margin before that. */
const TOKEN_TTL_MS = 55 * 60 * 1000;

/**
 * The FCM error code: `error.details[].errorCode` under Google's FCM error
 * type, falling back to the canonical `error.status` (a body commonly carries
 * `NOT_FOUND` with `UNREGISTERED` in the details).
 */
function fcmErrorCode(body: unknown): string {
  if (typeof body !== "object" || body === null || !("error" in body)) return "";
  const { error } = body;
  if (typeof error !== "object" || error === null) return "";
  if ("details" in error && Array.isArray(error.details)) {
    for (const detail of error.details) {
      if (typeof detail === "object" && detail !== null && "errorCode" in detail) {
        const { errorCode } = detail;
        if (typeof errorCode === "string") return errorCode;
      }
    }
  }
  return "status" in error && typeof error.status === "string" ? error.status : "";
}

/**
 * Build an FCM transport. A factory so the credential and endpoint are
 * explicit: a test points `host` at a local server and asserts the send, which
 * a module reading `process.env` at import could not be made to do.
 */
export function createFcmTransport(config: FcmConfig): PushTransport {
  const origin = config.port
    ? `http://${config.host}:${config.port}`
    : `https://${config.host}`;

  let account: ServiceAccount | null = null;
  let accountError: string | null = null;
  let accessToken: { value: string; expiresAt: number } | null = null;

  /**
   * Parse and validate the service-account JSON once. The private key is
   * checked for a PEM body here rather than at first send, so a secret pasted
   * without its newlines is reported as a configuration problem instead of a
   * delivery failure per push.
   */
  function loadAccount(): ServiceAccount | null {
    if (account) return account;
    if (accountError) return null;
    if (!config.serviceAccountJson) {
      accountError = "FCM service account is not set";
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(config.serviceAccountJson);
      if (typeof parsed !== "object" || parsed === null) {
        accountError = "FCM service account is not a JSON object";
        return null;
      }
      const { project_id, client_email, private_key } = parsed as {
        project_id?: unknown;
        client_email?: unknown;
        private_key?: unknown;
      };
      if (
        typeof project_id !== "string" ||
        typeof client_email !== "string" ||
        typeof private_key !== "string"
      ) {
        accountError =
          "FCM service account must carry project_id, client_email and private_key";
        return null;
      }
      // A single-line secret value commonly escapes its newlines.
      const pem = private_key.replace(/\\n/g, "\n");
      pemToDer(pem);
      account = { projectId: project_id, clientEmail: client_email, privateKey: pem };
      return account;
    } catch (error) {
      accountError = `FCM service account is not usable: ${
        error instanceof Error ? error.message : String(error)
      }`;
      return null;
    }
  }

  /** An access token from the service account, cached until near expiry. */
  async function fcmToken(): Promise<string> {
    const loaded = loadAccount();
    if (!loaded) throw new Error(accountError ?? "FCM is not configured");
    const now = Date.now();
    if (accessToken && accessToken.expiresAt > now) return accessToken.value;

    const key = await importSigningKey("RS256", pemToDer(loaded.privateKey));
    const nowSec = Math.floor(now / 1000);
    const assertion = await signJwt(
      "RS256",
      key,
      { alg: "RS256", typ: "JWT" },
      {
        // `iss` is the service-account email. Google reserves `sub` for
        // domain-wide delegation, so it is deliberately absent.
        iss: loaded.clientEmail,
        scope: SCOPE,
        aud: TOKEN_URL,
        iat: nowSec,
        // Google caps an assertion's lifetime at an hour.
        exp: nowSec + 3600,
      },
    );

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`FCM token exchange failed (${res.status}): ${text.slice(0, 200)}`);
    }
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("FCM token exchange returned an unexpected body");
    }
    const { access_token, expires_in } = parsed as {
      access_token?: unknown;
      expires_in?: unknown;
    };
    if (typeof access_token !== "string") {
      throw new Error("FCM token exchange returned no access_token");
    }
    const lifetimeMs =
      typeof expires_in === "number"
        ? // Google reports seconds; leave a minute of margin and never cache
          // past this module's own ceiling.
          Math.min(expires_in * 1000 - 60_000, TOKEN_TTL_MS)
        : TOKEN_TTL_MS;
    accessToken = { value: access_token, expiresAt: now + lifetimeMs };
    return accessToken.value;
  }

  return {
    kind: "fcm",
    isConfigured: () => loadAccount() !== null,
    async deliver(
      target: PushTarget,
      body: string,
      options: PushDeliveryOptions,
    ): Promise<PushOutcome> {
      const loaded = loadAccount();
      // An unconfigured transport attempts nothing, so the row is counted as
      // skipped rather than failed, and is never pruned on our own account.
      if (!loaded) return { outcome: "skipped", status: null };

      let alert: { title: string; body: string };
      try {
        alert = notificationText(JSON.parse(body) as PushPayload);
      } catch (error) {
        return { outcome: "retry", status: null, error };
      }

      const message = {
        message: {
          token: target.endpoint,
          notification: { title: alert.title, body: alert.body },
          data: { roomy: body },
          android: {
            priority: options.urgency === "low" ? "normal" : "high",
            // Duration format is a string of seconds, e.g. "2419200s".
            ttl: `${options.ttl ?? 2419200}s`,
            ...(options.topic ? { collapse_key: options.topic } : {}),
          },
        },
      };

      try {
        const authorization = await fcmToken();
        const res = await fetch(
          `${origin}/v1/projects/${loaded.projectId}/messages:send`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${authorization}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(message),
          },
        );
        if (res.ok) return { outcome: "delivered", status: res.status };

        const text = await res.text();
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          // Non-JSON error body — the status alone classifies the result.
        }
        const code = fcmErrorCode(parsed);
        if (code === "UNREGISTERED" || code === "NOT_FOUND" || res.status === 404) {
          log.info(`[push-fcm] token rejected (${res.status} ${code}) — pruning`);
          return { outcome: "gone", status: res.status };
        }
        if (res.status === 401) {
          // The bearer token was refused: drop it so the next attempt mints a
          // fresh one rather than replaying a token Google has rejected.
          accessToken = null;
        }
        return {
          outcome: "retry",
          status: res.status,
          error: new Error(code || text.slice(0, 200) || `HTTP ${res.status}`),
        };
      } catch (error) {
        return { outcome: "retry", status: null, error };
      }
    },
  };
}

/** The transport named by `FCM_*`, registered at import. */
PUSH_TRANSPORTS.fcm = createFcmTransport({
  serviceAccountJson: process.env.FCM_SERVICE_ACCOUNT ?? "",
  host: process.env.FCM_API_HOST ?? "fcm.googleapis.com",
});
