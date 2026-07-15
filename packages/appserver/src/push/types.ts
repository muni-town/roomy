/**
 * Shared types for the push pipeline.
 *
 * A {@link PushJob} is enqueued by `SpaceMaterializer` on a live
 * `createMessage` and drained by the {@link PushDispatcher} background loop.
 * The materializer only enqueues a small job; all DB lookups + network
 * delivery happen in the background so push never blocks materialisation
 * (same pattern as the embed sweeper).
 */

import type { UserDid } from "@roomy-space/sdk";

/** A live createMessage to evaluate for push delivery. */
export interface PushJob {
  /** The space (Leaf stream DID) the message was sent in. */
  spaceId: string;
  /** The room the message was sent in. */
  roomId: string;
  /** The message entity ULID (also encodes the timestamp via decodeTime). */
  messageId: string;
  /** Effective author DID (override-author if present, else the stream user). */
  authorDid: UserDid;
  /** Message timestamp in epoch milliseconds. */
  timestamp: number;
}

/**
 * Encrypted push payload (JSON, encrypted by `web-push`).
 *
 * Per the web-push plan's recommendation (open question #4), the initial
 * release carries counts + room/sender names only — no message body — so
 * no message content traverses the (third-party) push service. The service
 * worker uses `roomName`/`authorName` for the visible title/body and
 * `spaceId`/`roomId` for click-through navigation.
 */
export interface PushPayload {
  type: "message" | "digest";
  spaceId: string;
  roomId: string;
  /** Anchor message ULID (for `message` pushes). */
  messageId?: string;
  /** Number of messages this notification represents (1 for immediate, N for a digest). */
  count: number;
  /** Resolved room display name, when available. */
  roomName?: string;
  /** Resolved author display name for `message` pushes, when available. */
  authorName?: string;
  /**
   * Decoded message text content for `message` pushes. Only the first ~120
   * characters to keep the encrypted payload small — the push service never
   * sees the plaintext, but the payload is still transmitted over the wire
   * inside the encrypted envelope.
   */
  messageContent?: string;
  /**
   * Browser-fetchable avatar URL to show as the notification icon. The
   * appserver resolves this from `comp_info.avatar` (sender avatar for
   * `message` pushes, room/space avatar for `digest`), falling back through
   * "user avatar → space avatar". Not carried as content — it's metadata the
   * recipient can already see in-app — and the OS fetches the image itself.
   */
  icon?: string;
}

/** A recipient + the payload to deliver to all their subscriptions. */
export interface PushDelivery {
  userDid: string;
  payload: PushPayload;
}