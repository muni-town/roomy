/**
 * Schema for `space.roomy.push.getVapidPublicKey` (query).
 * Source of truth: packages/appserver/src/handlers/space.roomy.push.getVapidPublicKey.ts
 *
 * Returns the appserver's VAPID public key (uncompressed P-256, base64url),
 * which the browser passes to `pushManager.subscribe({ applicationServerKey })`.
 * Public — no auth required — but kept on the same router for simplicity.
 */
import { type } from "arktype";

export const NSID = "space.roomy.push.getVapidPublicKey" as const;

export const Params = type({});

export const Response = type({
  publicKey: "string",
});