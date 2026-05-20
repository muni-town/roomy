<script lang="ts">
  import "../app.css";
  import { onMount, untrack } from "svelte";
  import { QueryClientProvider } from "@tanstack/svelte-query";
  import { queryClient } from "$lib/client";
  import { auth, init } from "$lib/auth.svelte";
  import { startSync, stopSync } from "$lib/sync.svelte";

  let { children } = $props();

  onMount(() => {
    init();
  });

  $effect(() => {
    if (auth.authenticated) {
      untrack(() => startSync());
      return () => untrack(() => stopSync());
    }
  });

  $effect(() => {
    if (
      auth.authenticated &&
      auth.agent &&
      auth.session &&
      localStorage.getItem("just-logged-in") != undefined
    ) {
      const agent = auth.agent;
      const did = auth.session.did;
      (async () => {
        try {
          const profile = await agent.app.bsky.actor.getProfile({ actor: did });
          localStorage.setItem(
            "last-login",
            JSON.stringify({
              handle: profile.data.handle,
              did,
              avatar: profile.data.avatar ?? "",
            }),
          );
        } catch (e) {
          console.warn("Failed to cache last-login profile:", e);
        } finally {
          localStorage.removeItem("just-logged-in");
        }
      })();
    }
  });
</script>

<QueryClientProvider client={queryClient}>
  {@render children()}
</QueryClientProvider>
