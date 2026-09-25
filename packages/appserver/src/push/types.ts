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
  /** The space (stream DID) the message was sent in. */
  spaceId: string;
  /** The room the message was sent in. */
  roomId: string;
  /** The message entity ULID (also encodes the timestamp via decodeTime). */
  messageId: string;
  /** Effective author DID (override-author if present, else the stream user). */
  authorDid: UserDid;
  /** Message timestamp in epoch milliseconds. */
  timestamp: number;
  /**
   * The message's **canonical** timestamp in epoch ms — the timestamp
   * override extension when present (Discord-bridged messages carry the
   * original Discord send time), else the event ULID time. Computed on the
   * write path by `canonicalMessageTimestamp`.
   *
   * This is the only time value that distinguishes a genuinely new message
   * from historical content ingested now: `timestamp` is derived from the
   * event ULID, which is fresh for a replay. The freshness gate
   * (`push/freshness.ts`) keys on this field.
   */
  canonicalTimestamp?: number;
  /** DIDs mentioned in the message body (from the mentions extension). */
  mentions?: string[];
  /**
   * DIDs notified of a direct (depth-1) reply: the author(s) of the
   * replied-to message(s). Resolved by the enqueue site (StreamManager,
   * on the write path, batched) — the dispatcher never walks reply edges.
   */
  repliedToDids?: string[];
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
  /**
   * Resolved author display name. Never the raw DID while a friendlier name
   * exists: per-space `comp_info.name` → `comp_user.handle` → global
   * `profiles` store → the DID itself (see `resolveAuthorName`). Present on
   * every `message` push and on `digest` pushes whose room has a known
   * most-recent author.
   */
  authorName?: string;
  /**
   * The author's DID. Always carried alongside `authorName` so the service
   * worker can still name the author if `authorName` is somehow missing
   * (legacy/synthetic payloads) — a notification must never read "New
   * message" while the sender's DID is known.
   */
  authorDid?: string;
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