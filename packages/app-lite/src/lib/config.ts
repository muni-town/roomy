const APPSERVER_RPCS = [
  "space.roomy.space.getSpaces",
  "space.roomy.space.getMetadata",
  "space.roomy.space.getThreads",
  "space.roomy.space.getRoles",
  "space.roomy.space.getMembers",
  "space.roomy.space.getInvites",
  "space.roomy.room.getMetadata",
  "space.roomy.room.getMessages",
  "space.roomy.room.getThreads",
  "space.roomy.message.getMessage",
  "space.roomy.auth.getConnectionTicket",
  "space.roomy.room.updateSeen",
  "space.roomy.space.sendEvents",
  "space.roomy.space.createSpace",
  "space.roomy.space.joinSpace",
  "space.roomy.space.leaveSpace",
  "space.roomy.space.getCalendarLink",
  "space.roomy.space.getCalendarEvents",
];

export const OAUTH_SCOPE = [
  "atproto",
  "rpc:app.bsky.actor.getProfiles?aud=did:web:api.bsky.app%23bsky_appview",
  "rpc:app.bsky.actor.getProfile?aud=did:web:api.bsky.app%23bsky_appview",
  "blob:*/*",
  ...APPSERVER_RPCS.map((nsid) => `rpc:${nsid}?aud=*`),
].join(" ");

export const CONFIG = {
  appserverDid:
    import.meta.env.VITE_APPSERVER_DID || "did:web:appserver.roomy.chat",
  port: Number(import.meta.env.VITE_PORT) || 5180,
  usePublicClient: import.meta.env.VITE_OAUTH_PUBLIC_CLIENT === "true",
};
