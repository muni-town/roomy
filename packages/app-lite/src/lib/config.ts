import { env as dynamicEnv } from "$env/dynamic/public";

export const CONFIG = {
  appserverDid:
    import.meta.env.VITE_APPSERVER_DID || "did:web:api.roomy.space",
  /**
   * Override the WebSocket origin for the sync connection.
   * When set, bypasses DID document resolution and uses this URL directly.
   * Useful for local development: VITE_APPSERVER_WS_ORIGIN=ws://127.0.0.1:8080
   */
  appserverWsOrigin: import.meta.env.VITE_APPSERVER_WS_ORIGIN || null,
  /**
   * HTTP origin for direct XRPC calls (getMessages, updateSeen, …). In local
   * dev we derive it from the WS-origin override so a single
   * VITE_APPSERVER_WS_ORIGIN points BOTH the sync WebSocket and the XRPC HTTP
   * client at the local appserver. When unset, the HTTP origin is resolved
   * from the appserver DID (i.e. production).
   */
  appserverHttpOrigin:
    (import.meta.env.VITE_APPSERVER_WS_ORIGIN || "")
      .replace(/^ws(s?):\/\//, "http$1://")
      .replace(/\/+$/, "") || null,
  /**
   * The public web deployment of this app — the origin shareable links are
   * rooted at, never the document origin. The desktop app is a Tauri webview
   * served from a custom scheme (`tauri://localhost`), so a shareable link
   * built from `location.origin` inside it is unopenable by its recipient.
   *
   * Two consumers: `share-url.ts` falls back to it when the document is not
   * the web deployment, and it is the `PUBLIC_WEB_ORIGIN` marker that tells a
   * build being served from its own configured origin that it may use
   * `location.origin`. A build with no such marker (the desktop bundle) can
   * therefore never mistake the webview for the public app — a static build
   * serving at `http://localhost:5180` included.
   *
   * The default matches the `https` appLink host declared in
   * `src-tauri/tauri.conf.json`: the desktop app's own statement of which web
   * origin it belongs to.
   */
  publicWebOrigin: import.meta.env.VITE_PUBLIC_WEB_ORIGIN || "https://roomy.space",
  publicWebOriginMarker: dynamicEnv.PUBLIC_WEB_ORIGIN || null,
  port: Number(import.meta.env.VITE_PORT) || 5180,
  usePublicClient: import.meta.env.VITE_OAUTH_PUBLIC_CLIENT === "true",
  profileSpaceNsid:
    import.meta.env.VITE_STREAM_HANDLE_NSID || "space.roomy.space.handle.dev",
  /** Test-mode app-password credentials (bake into env for headless E2E). */
  testIdentifier: dynamicEnv.PUBLIC_TEST_IDENTIFIER || null,
  testAppPassword: dynamicEnv.PUBLIC_TEST_APP_PASSWORD || null,
  /**
   * PDS to authenticate the test-mode app-password login against. Reuses
   * `PUBLIC_PDS` (the same PDS account creation targets), so a headless E2E
   * run against a self-hosted PDS works without a second setting. Defaults to
   * bsky.social.
   */
  testPds: dynamicEnv.PUBLIC_PDS || "https://bsky.social",
  /**
   * Grafana Faro endpoint for browser telemetry (frontend log collection).
   * Points at an Alloy `faro.receiver` (dev compose: http://127.0.0.1:12345,
   * prod: the deploy/alloy collector). When unset the Faro SDK is never
   * loaded/initialized — dev/build default is disabled.
   */
  faroUrl: dynamicEnv.PUBLIC_FARO_URL || null,
  /**
   * Faro API key sent as `x-api-key` with each telemetry POST. The dev
   * compose `faro.receiver` requires the placeholder "bad_api_key"; prod
   * defaults to no key (FARO_API_KEY unset on the collector). Note: a key
   * baked into a static client bundle is readable by anyone — it only gates
   * random browsers from writing to the collector, it is not a secret.
   */
  faroApiKey: dynamicEnv.PUBLIC_FARO_API_KEY || null,
};

/**
 * Member limit of the free Discord Bridge tier (no Roomy Pro membership).
 * Mirrors the "up to 50 members" tier copy in the design system's
 * PricingTiers and the subscription page; the bridge enforces the Pro
 * capacity server-side, while this constant is only for UI copy on the
 * space's bridge settings.
 */
export const FREE_BRIDGE_MEMBER_LIMIT = 50;
