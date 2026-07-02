/**
 * Minimal ambient types for the `web-push` npm package (v3), which ships no
 * bundled `.d.ts`. Only the surface the appserver uses is declared.
 *
 * `web-push` is pure JS and runs under Bun. It handles VAPID JWT signing
 * and RFC 8291 (`aes128g2`) payload encryption; the appserver POSTs the
 * encrypted body to each subscription's push-service endpoint.
 */

declare module "web-push" {
  /** A stored push subscription, shaped like `PushSubscription.toJSON()`. */
  export interface PushSubscription {
    endpoint: string;
    keys: {
      p256dh: string;
      auth: string;
    };
    expirationTime?: number | null;
  }

  /** Options passed to `sendNotification`. */
  export interface SendNotificationOptions {
    /** TTL in seconds for the message if the user is offline. */
    TTL?: number;
    /** VAPID subject/publicKey/privateKey, overriding global `setVapidDetails`. */
    vapidDetails?: {
      subject: string;
      publicKey: string;
      privateKey: string;
    };
    /** Urgency hint: "very-low" | "low" | "normal" | "high". */
    urgency?: "very-low" | "low" | "normal" | "high";
    /** Topic string so notifications with the same topic replace each other. */
    topic?: string;
    /** Request timeout in milliseconds. */
    timeout?: number;
  }

  /** Error thrown by `sendNotification` on a non-2xx push-service response. */
  export class WebPushError extends Error {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
    endpoint: string;
  }

  /** A freshly generated VAPID keypair (uncompressed P-256, base64url). */
  export interface VapidKeys {
    publicKey: string;
    privateKey: string;
  }

  export function setVapidDetails(
    subject: string,
    publicKey: string,
    privateKey: string,
  ): void;

  export function sendNotification(
    subscription: PushSubscription,
    payload?: string | Buffer | null,
    options?: SendNotificationOptions,
  ): Promise<void>;

  export function generateVAPIDKeys(): VapidKeys;

  export const supportedContentEncodings: string[];
}