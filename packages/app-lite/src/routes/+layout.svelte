<script lang="ts">
  import "../app.css";
  import { onMount, untrack } from "svelte";
  import { onNavigate } from "$app/navigation";
  import { QueryClientProvider } from "@tanstack/svelte-query";
  import { queryClient } from "$lib/client";
  import { auth, init, updateProfile } from "$lib/auth.svelte";
  import { startSync, stopSync } from "$lib/sync.svelte";
  import {
    installGlobalErrorRecovery,
    resetReloadBudget,
  } from "$lib/error-recovery";
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
    // Catch unhandled ATProto rejections (e.g. background token refresh
    // failures) that would otherwise leave the app unusable. In the PWA the
    // page cannot be manually refreshed, so this is the safety net.
    installGlobalErrorRecovery();
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

  // Fetch ATProto profile as soon as we're authenticated.
  // This populates the reactive `auth.profile` so the sidebar user card
  // updates immediately (no stale localStorage-driven delay).
  $effect(() => {
    if (auth.authenticated) {
      updateProfile();
    }
  });

  $effect(() => {
    if (auth.authenticated) {
      untrack(() => startSync());
      return () => untrack(() => stopSync());
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
    <!-- init failed — show error with a manual reload affordance. This is
         the PWA recovery fallback when auto-reload has given up (loop
         protection) or the error is not auto-recoverable. -->
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-base-50/90 dark:bg-base-950/90 backdrop-blur-sm"
    >
      <div
        class="m-4 p-4 rounded-2xl text-sm bg-red-50 dark:bg-red-950/30 text-red-800 dark:text-red-300 max-w-md flex flex-col gap-3"
      >
        <div class="font-semibold">Something went wrong</div>
        <pre class="whitespace-pre-wrap break-words text-xs opacity-80">{auth.initError}</pre>
        <button
          type="button"
          class="self-start rounded-lg px-3 py-1.5 text-sm font-medium bg-red-600 text-white hover:bg-red-700 active:bg-red-800 transition-colors"
          onclick={() => {
            // Give the user a fresh auto-reload budget, then reload.
            resetReloadBudget();
            location.reload();
          }}
        >
          Reload
        </button>
      </div>
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
