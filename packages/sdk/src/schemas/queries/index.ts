/**
 * Namespaced re-exports of every XRPC query schema (params + response).
 * Import as:
 *   import { queries } from "@roomy-space/sdk/schemas";
 *   queries.getSpaces.Response(json);
 */
export * as getSpaces from "./getSpaces";
export * as getActivityFeed from "./getActivityFeed";
export * as getSpaceMetadata from "./getSpaceMetadata";
export * as getSpaceThreads from "./getSpaceThreads";
export * as getRoles from "./getRoles";
export * as getMembers from "./getMembers";
export * as getInvites from "./getInvites";
export * as getRoomMetadata from "./getRoomMetadata";
export * as getRoomThreads from "./getRoomThreads";
export * as getMessages from "./getMessages";
export * as getMessage from "./getMessage";
export * as getReactions from "./getReactions";
export * as getEvents from "./getEvents";
export * as getVapidPublicKey from "./getVapidPublicKey";
export * as getPreferences from "./getPreferences";
