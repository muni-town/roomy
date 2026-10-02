/**
 * Visible notification text for a decrypted push payload.
 *
 * The payload is produced by the appserver (`packages/appserver/src/push/`)
 * and rendered in three places that must agree, which is why the renderer
 * lives here rather than in any one of them:
 *
 *  - the service worker, for a browser push (`app-lite/src/service-worker.ts`),
 *  - the appserver's APNs transport, which must put the text in `aps.alert`
 *    because iOS shows it with no app running,
 *  - the appserver's FCM transport, which does the same via `notification`.
 *
 * The author is the headline: `authorName` when the server resolved one, else
 * the raw `authorDid` (the server guarantees `authorDid` on every payload it
 * builds). "New message" is only for a payload carrying no author at all.
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
      title: author ? `${author} in ${room}` : `${count} new messages in ${room}`,
      body: `${count} new messages`,
    };
  }

  return {
    title: author ? `${author} in ${room}` : `New message in ${room}`,
    body: payload.messageContent
      ? payload.messageContent
      : author
        ? `${author} sent a message`
        : "New message",
  };
}
