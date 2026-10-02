/**
 * The push payload → visible notification contract, shared by the appserver
 * (which renders APNs/FCM alert text) and the client service worker (which
 * renders a browser push).
 *
 * A subpath of its own so the service worker pulls in the renderer and nothing
 * else — the core `@roomy-space/sdk` entry carries the ATProto client and the
 * sync stack, none of which belongs in a worker bundle.
 */

export {
  notificationText,
  type PushNotificationView,
} from "./notificationText";
