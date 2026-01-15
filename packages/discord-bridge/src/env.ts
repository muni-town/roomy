// Discord configuration
export const DISCORD_TOKEN = process.env.DISCORD_TOKEN as string;
if (!DISCORD_TOKEN)
  throw new Error("DISCORD_TOKEN environment variable not provided.");

export const PORT = parseInt(process.env.PORT || "3301");

// ATProto / Roomy configuration
export const ATPROTO_BRIDGE_DID = process.env.ATPROTO_BRIDGE_DID as string;
export const ATPROTO_BRIDGE_APP_PASSWORD = process.env
  .ATPROTO_BRIDGE_APP_PASSWORD as string;

if (!ATPROTO_BRIDGE_DID || !ATPROTO_BRIDGE_APP_PASSWORD) {
  throw new Error(
    "ATPROTO_BRIDGE_DID and ATPROTO_BRIDGE_APP_PASSWORD environment variables required.",
  );
}

// Leaf server configuration (defaults to dev environment)
export const LEAF_URL = process.env.LEAF_URL || "https://leaf-dev.muni.town";
export const LEAF_SERVER_DID = `did:web:${new URL(LEAF_URL).hostname}`;

// ATProto record collections (defaults to dev environment)
export const STREAM_NSID =
  process.env.STREAM_NSID || "space.roomy.space.personal.dev";
export const STREAM_HANDLE_NSID =
  process.env.STREAM_HANDLE_NSID || "space.roomy.space.handle.dev";
