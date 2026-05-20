import { QueryClient } from "@tanstack/svelte-query";

// WS is sole freshness authority — all queries use staleTime: Infinity.
// HTTP re-fetches only happen on WS invalidation signals.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
  },
});
