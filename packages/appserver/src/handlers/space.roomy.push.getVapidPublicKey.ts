/**
 * XRPC: space.roomy.push.getVapidPublicKey (query).
 *
 * Returns the appserver's VAPID public key (base64url) for the browser to pass
 * to `pushManager.subscribe({ applicationServerKey })`. Public — no auth
 * required — but kept on the same router for simplicity. Returns an empty
 * string when VAPID isn't configured (dev/test without keys); the client
 * should treat a falsy/empty key as "push unavailable".
 */

import { getVapidPublicKey } from "../push/webpush.ts";
import type { QueryHandler, QueryParams } from "../xrpc/types.ts";

interface GetVapidPublicKeyResult {
  publicKey: string;
}

export const getVapidPublicKeyHandler: QueryHandler<
  QueryParams,
  GetVapidPublicKeyResult
> = async () => {
  // publicKey is required by the lexicon schema (string). When VAPID isn't
  // configured we return an empty string so the wire shape still validates;
  // the client checks for a falsy/empty key to detect "push unavailable".
  return { publicKey: getVapidPublicKey() ?? "" };
};