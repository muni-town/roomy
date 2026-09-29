import {
  QueryClient,
  QueryCache,
  MutationCache,
  type QueryClientConfig,
} from "@tanstack/svelte-query";
import { scheduleAutoReload } from "$lib/error-recovery";
import { transport } from "@roomy-space/sdk";
import { CONFIG } from "./config";
import { getAppserverOrigin, setAppserverOrigin } from "./appserver-origin";

const { DirectXrpcClient, resolveAppserverHttpOrigin } = transport;

/**
 * Cached unauthenticated XRPC client. Lazily created on first use, re-used
 * thereafter. Points at the same appserver as the authed client (local-dev
 * override, then the cached DID-resolved origin, then fresh DID resolution).
 */
let unauthXrpc: InstanceType<typeof DirectXrpcClient> | null = null;

/**
 * Get an unauthenticated XRPC client for calling anonymous appserver
 * endpoints — most notably `space.roomy.auth.getLoginScope`, which the app
 * must call *before* the user has a token (to decide which scope to request
 * at login). Returns the cached singleton.
 *
 * Unlike {@link auth.px}, this throws nothing about not being signed in: it
 * is meaningful with or without a session, and never mints a service-auth
 * token (the `DirectXrpcClient` is built with no `serviceAuth`).
 */
export async function pxUnauth(): Promise<
  InstanceType<typeof DirectXrpcClient>
> {
  if (unauthXrpc) return unauthXrpc;
  const appserverUrl =
    CONFIG.appserverHttpOrigin ??
    getAppserverOrigin() ??
    (await resolveAppserverHttpOrigin(CONFIG.appserverDid));
  // Cache the resolved origin so the authed setup path reuses it too.
  setAppserverOrigin(appserverUrl);
  unauthXrpc = new DirectXrpcClient(appserverUrl, CONFIG.appserverDid);
  return unauthXrpc;
}

// WS is sole freshness authority — all queries use staleTime: Infinity.
// HTTP re-fetches only happen on WS invalidation signals.
//
// The query/mutation cache `onError` callbacks route recoverable ATProto
// session/auth errors (expired/revoked tokens, failed service-auth) to the
// auto-reload recovery in `error-recovery.ts`. Without this, a dead OAuth
// session leaves every query in an error state with no way to recover —
// especially in the PWA, where the page cannot be manually refreshed.
const config: QueryClientConfig = {
  queryCache: new QueryCache({
    onError: (err) => scheduleAutoReload(err),
  }),
  mutationCache: new MutationCache({
    onError: (err) => scheduleAutoReload(err),
  }),
  defaultOptions: {
    queries: {
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
  },
};

export const queryClient = new QueryClient(config);