import { dev } from "$app/environment";
import {
  atprotoLoopbackClientMetadata,
  BrowserOAuthClient,
  buildLoopbackClientId,
  type OAuthClientMetadataInput,
} from "@atproto/oauth-client-browser";
import { isTauri } from "@tauri-apps/api/core";

const scope = "atproto transition:generic transition:chat.bsky";

let oauth = $state() as BrowserOAuthClient | undefined;

/** The AtProto store. */
export const atproto = {
  /** The scope required by the app when logging in. */
  scope,

  /**
   * The AtProto oauth client.
   *
   * `init()` must be called before use
   */
  get oauth() {
    // Here we lie about the type with a non-null assertion because we
    // are going to need it constantly throughout the codebase and errors
    // about an undefined oauth will be very obviously a failure to await on
    // init() first.
    return oauth!;
  },

  /** Init function must be called before accessing the oauth client. */
  async init() {
    // Skip initialization if already initialized.
    if (this.oauth) return;

    // Build the client metadata
    let clientMetadata: OAuthClientMetadataInput;
    if (dev && !isTauri()) {
      // Get the base URL and redirect URL for this deployment
      const baseUrl = new URL(
        dev ? "http://127.0.0.1:5173" : globalThis.location.href,
      );
      baseUrl.hash = "";
      baseUrl.pathname = "/";
      const redirectUri = baseUrl.href + "oauth/callback";
      // In dev, we build a development metadata
      clientMetadata = {
        ...atprotoLoopbackClientMetadata(buildLoopbackClientId(baseUrl)),
        redirect_uris: [redirectUri],
        scope,
        client_id: `http://localhost?redirect_uri=${encodeURIComponent(
          redirectUri,
        )}&scope=${encodeURIComponent(scope)}`,
      };
    } else {
      // In prod, we fetch the `/oauth-client.json` which is expected to be deployed alongside the
      // static build.
      // native client metadata is not reuqired to be on the same domin as client_id,
      // so it can always use the deployed metadata
      const resp = await fetch(
        `/oauth-client${isTauri() ? "-native" : ""}.json`,
        {
          headers: [["accept", "application/json"]],
        },
      );
      clientMetadata = await resp.json();
    }

    // Build the oauth client
    oauth = new BrowserOAuthClient({
      responseMode: "query",
      handleResolver: "https://resolver.roomy.chat",
      clientMetadata,
    });
  },
};
