import { env as dynamicEnv } from "$env/dynamic/public";

/**
 * Comma-separated DIDs allowed to access the admin dashboard.
 * Set via PUBLIC_APPSERVER_ADMIN_DIDS in the appserver-admin .env.
 * Fails closed: if unset or empty, no one can log in.
 */
const RAW_DIDS = dynamicEnv.PUBLIC_APPSERVER_ADMIN_DIDS ?? "";

export const ADMIN_DIDS: ReadonlySet<string> = new Set(
  RAW_DIDS.split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0),
);

export const CONFIG = {
  appserverDid:
    import.meta.env.VITE_APPSERVER_DID || "did:web:appserver.roomy.chat",
  appserverWsOrigin: import.meta.env.VITE_APPSERVER_WS_ORIGIN || null,
  appserverHttpOrigin:
    (import.meta.env.VITE_APPSERVER_WS_ORIGIN || "")
      .replace(/^ws(s?):\/\//, "http$1://")
      .replace(/\/+$/, "") || null,
  port: Number(import.meta.env.VITE_PORT) || 5200,
  usePublicClient: import.meta.env.VITE_OAUTH_PUBLIC_CLIENT === "true",
};
