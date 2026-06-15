<script lang="ts">
  import "../app.css";
  import { onMount, untrack } from "svelte";
  import { onNavigate } from "$app/navigation";
  import { QueryClientProvider } from "@tanstack/svelte-query";
  import { queryClient } from "$lib/client";
  import { auth, init } from "$lib/auth.svelte";
  import { startSync, stopSync } from "$lib/sync.svelte";
  import { requireAuth } from "$lib/components/layout/auth-guard.svelte";
  import LoginModal from "$lib/components/auth/LoginModal.svelte";
  import LoadingSpinner from "@roomy/design/components/helper/LoadingSpinner.svelte";
  import MainLayout from "$lib/components/layout/MainLayout.svelte";
  import { Toaster as FxUIToaster } from "@foxui/core";
  import { Tooltip } from "bits-ui";

  // Debug: log all public env vars
  import { env as dynamicEnv } from "$env/dynamic/public";

  console.log("[app-lite env debug] import.meta.env (static):", {
    VITE_APPSERVER_DID: import.meta.env.VITE_APPSERVER_DID,
    VITE_APPSERVER_WS_ORIGIN: import.meta.env.VITE_APPSERVER_WS_ORIGIN,
    VITE_PORT: import.meta.env.VITE_PORT,
    VITE_OAUTH_PUBLIC_CLIENT: import.meta.env.VITE_OAUTH_PUBLIC_CLIENT,
    VITE_STREAM_HANDLE_NSID: import.meta.env.VITE_STREAM_HANDLE_NSID,
  });

  let { children } = $props();

  onMount(() => {
    console.log("[app-lite env debug] $env/dynamic/public:", {
      PUBLIC_PDS: dynamicEnv.PUBLIC_PDS,
      PUBLIC_PDS_HANDLE_SUFFIX: dynamicEnv.PUBLIC_PDS_HANDLE_SUFFIX,
      PUBLIC_PDS_INVITE_CODE: dynamicEnv.PUBLIC_PDS_INVITE_CODE,
      PUBLIC_DISCORD_BRIDGE: dynamicEnv.PUBLIC_DISCORD_BRIDGE,
      PUBLIC_BRIDGE_DID: dynamicEnv.PUBLIC_BRIDGE_DID,
    });
    init();
  });

  // ── Centralized navigation guard ─────────────────────────────────────────
  // Reset module-level state that lacks per-page cleanup on every SvelteKit
  // navigation. Navbar/sidebar are handled by per-page onMount cleanups;
  // messagingState is reset by the room page on room change.
  onNavigate(() => {
    requireAuth.value = true;
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
  <Tooltip.Provider>
  <MainLayout>
    {@render children()}
  </MainLayout>
  </Tooltip.Provider>

  <FxUIToaster />

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
