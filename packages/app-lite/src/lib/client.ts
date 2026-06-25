import {
  QueryClient,
  QueryCache,
  MutationCache,
  type QueryClientConfig,
} from "@tanstack/svelte-query";
import { scheduleAutoReload } from "$lib/error-recovery";

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