/**
 * FCM transport (Android, and Chrome without Web Push), not yet implemented.
 *
 * Draft registration. It answers `skipped` for every row, so a stored `fcm`
 * device is counted as "a transport declined" rather than as a delivery or a
 * failure — the honest answer while there is no wire call here. It must never
 * answer `gone`: that prunes the row, and a device whose transport has not
 * shipped would then be unregistered for a reason that has nothing to do with
 * the device.
 *
 * The wire call, once built, is an HTTP v1 POST to
 * `https://fcm.googleapis.com/v1/projects/<project>/messages:send` with an
 * OAuth2 bearer token minted from a service-account JSON. `collapse_key` maps
 * from {@link PushDeliveryOptions.topic}; the same JSON body the Web Push
 * transport sends is carried in the `data` field. `UNREGISTERED`/`NOT_FOUND`
 * map to `gone`; `UNAVAILABLE`/`INTERNAL` map to `retry`.
 *
 * See `docs/plans/native-push-plan.md`.
 */

import {
  PUSH_TRANSPORTS,
  type PushDeliveryOptions,
  type PushOutcome,
  type PushTransport,
  type PushTarget,
} from "./types.ts";

const fcmTransport: PushTransport = {
  kind: "fcm",
  // Reads the service-account JSON and probes it against Google once the wire
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

PUSH_TRANSPORTS[fcmTransport.kind] = fcmTransport;

/**
 * Sketch of the sender, kept from the original contribution so the shape of the
 * token mint is on record. It needs a JWT signer (`jose`, or `node:crypto`'s
 * `createSign` with PKCS#8), which is not a dependency yet, so it is not wired
 * to `deliver` above.
 *
 * ```ts
 * type ServiceAccount = { client_email: string; private_key: string };
 *
 * async function getFcmAccessToken(serviceAccount: ServiceAccount): Promise<string> {
 *   const now = Math.floor(Date.now() / 1000);
 *   const jwt = await new jose.SignJWT({
 *     scope: "https://www.googleapis.com/auth/firebase.messaging",
 *   })
 *     .setProtectedHeader({ alg: "RS256", typ: "JWT" })
 *     .setIssuer(serviceAccount.client_email)
 *     .setAudience("https://oauth2.googleapis.com/token")
 *     .setSubject(serviceAccount.client_email)
 *     .setIssuedAt(now)
 *     .setExpirationTime(now + 3600)
 *     .sign(await jose.importPKCS8(serviceAccount.private_key, "RS256"));
 *
 *   const res = await fetch("https://oauth2.googleapis.com/token", {
 *     method: "POST",
 *     headers: { "Content-Type": "application/x-www-form-urlencoded" },
 *     body: new URLSearchParams({
 *       grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
 *       assertion: jwt,
 *     }),
 *   });
 *   const { access_token } = await res.json();
 *   return access_token;
 * }
 *
 * async function send(target, body, options) {
 *   const accessToken = await getFcmAccessToken(serviceAccount);
 *   const res = await fetch(
 *     `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
 *     {
 *       method: "POST",
 *       headers: {
 *         Authorization: `Bearer ${accessToken}`,
 *         "Content-Type": "application/json",
 *       },
 *       body: JSON.stringify({
 *         message: {
 *           token: target.endpoint,
 *           data: { payload: body },
 *           ...(options.topic ? { collapse_key: options.topic } : {}),
 *           android: {
 *             priority: options.urgency === "high" ? "HIGH" : "NORMAL",
 *             ttl: `${options.ttl ?? 2419200}s`,
 *           },
 *         },
 *       }),
 *     },
 *   );
 *   if (res.ok) return { outcome: "delivered", status: res.status };
 *   // The app was uninstalled — the token will never be valid again.
 *   if (res.status === 404) return { outcome: "gone", status: res.status };
 *   if (res.status === 429) return { outcome: "retry", status: res.status, error: res };
 *   return { outcome: "retry", status: res.status, error: res };
 * }
 * ```
 */
