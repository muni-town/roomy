/**
 * Visible notification text for a decrypted web-push payload.
 *
 * Extracted out of the service worker so the render contract is testable:
 * the app-lite service worker imports this and feeds it decrypted payloads
 * (see `service-worker.ts`), and `packages/appserver/src/push/notificationText.test.ts`
 * exercises it with synthetic payloads. The payload shape mirrors
 * `packages/appserver/src/push/types.ts` — the server guarantees `authorDid`
 * on every push it builds, and `authorName` whenever the author is known.
 *
 * The author is the headline: `authorName` when the server resolved one,
 * else the raw `authorDid`. A notification must name its sender — "New
 * message" is only for the case where the payload carries no author at all,
 * which the server does not produce in practice.
 */

export interface PushNotificationView {
  type?: "message" | "digest";
  roomName?: string;
  authorName?: string;
  authorDid?: string;
  messageContent?: string;
  count?: number;
}

export function notificationText(payload: PushNotificationView): {
  title: string;
  body: string;
} {
  const count = payload.count ?? 1;
  const room = payload.roomName ?? "a room";
  const author = payload.authorName ?? payload.authorDid;

  if (payload.type === "digest") {
    return {
      title: author
        ? `${author} in ${room}`
        : `${count} new messages in ${room}`,
      body: `${count} new messages`,
    };
  }

  return {
    title: author
      ? `${author} in ${room}`
      : `New message in ${room}`,
    body: payload.messageContent
      ? payload.messageContent
      : author
        ? `${author} sent a message`
        : "New message",
  };
}
