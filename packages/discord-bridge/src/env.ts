function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} environment variable not provided.`);
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.length > 0 ? value : fallback;
}

export const DISCORD_TOKEN = required("DISCORD_TOKEN");

export const ATPROTO_BRIDGE_DID = required("ATPROTO_BRIDGE_DID");
export const ATPROTO_BRIDGE_APP_PASSWORD = required(
  "ATPROTO_BRIDGE_APP_PASSWORD",
);

export const LEAF_URL = optional("LEAF_URL", "https://leaf-dev.muni.town");
export const LEAF_SERVER_DID = optional(
  "LEAF_SERVER_DID",
  `did:web:${new URL(LEAF_URL).hostname}`,
);

export const STREAM_NSID = optional(
  "STREAM_NSID",
  "space.roomy.space.personal.dev",
);
export const STREAM_HANDLE_NSID = optional(
  "STREAM_HANDLE_NSID",
  "space.roomy.space.handle.dev",
);

export const BRIDGE_DATA_DIR = optional("BRIDGE_DATA_DIR", "./data");
export const PORT = parseInt(optional("PORT", "3301"), 10);
export const LOG_LEVEL = optional("LOG_LEVEL", "info");
