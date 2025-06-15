import { dev } from "$app/environment";
import {
  BrowserOAuthClient,
  type OAuthClientMetadataInput,
} from "@atproto/oauth-client-browser";
import { isTauri } from "@tauri-apps/api/core";
import { type } from "@tauri-apps/plugin-os";

const scope = "atproto transition:generic transition:chat.bsky";
const oatProxyUrl = "https://commonly-proper-amoeba.ngrok-free.app";

let oauth: BrowserOAuthClient | undefined = $state();

const fetchWithLies = async (input: RequestInfo | URL, init?: RequestInit) => {
  let request: Request;
  if (typeof input === "string" || input instanceof URL) {
    request = new Request(input, init);
  } else {
    request = input;
  }

  // Always intercept DID resolution to point to OATProxy
  if (
    request.url.includes("plc.directory") ||
    request.url.endsWith("did.json")
  ) {
    const res = await fetch(request, init);
    if (!res.ok) return res;
    const data = await res.json();
    const service = data.service?.find((s: any) => s.id === "#atproto_pds");
    if (service) {
      service.serviceEndpoint = oatProxyUrl;
    }
    return new Response(JSON.stringify(data), {
      status: res.status,
      headers: res.headers,
    });
  }

  // Route all XRPC requests through OATProxy
  if (request.url.includes("/xrpc/")) {
    const url = new URL(request.url);
    return fetch(`${oatProxyUrl}/xrpc${url.pathname}${url.search}`, {
      ...init,
      headers: {
        ...init?.headers,
        Authorization: request.headers.get("Authorization") || "",
      },
    });
  }

  return fetch(request, init);
};

export const atproto = {
  scope,

  get oauth() {
    return oauth!;
  },

  async init() {
    if (this.oauth) return;

    const clientMetadata: OAuthClientMetadataInput = {
      client_id: `${oatProxyUrl}/oauth/downstream/client-metadata.json`,
      redirect_uris: isTauri()
        ? type() === "android" || type() === "ios"
          ? ["https://roomy.chat/oauth/callback"]
          : ["chat.roomy:/oauth/callback"]
        : [`${oatProxyUrl}/oauth/callback`],
      scope,
      response_types: ["code"],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
      application_type: isTauri() ? "native" : "web",
    };

    oauth = new BrowserOAuthClient({
      responseMode: "query",
      handleResolver: oatProxyUrl,
      clientMetadata,
      fetch: (input, init) => fetchWithLies(input, init),
    });
  },
};
