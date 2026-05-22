<script lang="ts">
  import "../app.css";
  import { onMount, untrack } from "svelte";
  import { QueryClientProvider } from "@tanstack/svelte-query";
  import { queryClient } from "$lib/client";
  import { auth, init } from "$lib/auth.svelte";
  import { startSync, stopSync } from "$lib/sync.svelte";
  import { requireAuth } from "$lib/components/layout/auth-guard.svelte";
  import LoginModal from "$lib/components/auth/LoginModal.svelte";
  import LoadingSpinner from "@roomy/design/components/helper/LoadingSpinner.svelte";

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

  // Cache last-login profile after successful auth
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

  {#if auth.initError && requireAuth.value}
    <!-- init failed — show error behind modal -->
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-base-50/90 dark:bg-base-950/90 backdrop-blur-sm"
    >
      <pre
        class="m-4 p-3 rounded-2xl text-sm whitespace-pre-wrap bg-red-50 dark:bg-red-950/30 text-red-800 dark:text-red-300 max-w-md"
      >{auth.initError}</pre>
    </div>
  {:else if auth.initializing && !auth.authenticated && requireAuth.value}
    <!-- OAuth callback / session restoration in progress — skeleton -->
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-base-50 dark:bg-base-950"
    >
      <LoadingSpinner size={48} />
    </div>
  {:else if !auth.authenticated && requireAuth.value}
    <!-- Not logged in — show login modal -->
    <LoginModal />
  {/if}
</QueryClientProvider>
