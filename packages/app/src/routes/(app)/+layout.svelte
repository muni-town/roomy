<script lang="ts">
  import "../../app.css";
  import { dev } from "$app/environment";
  import { peerStatus } from "$lib/workers";
  import { onMount } from "svelte";
  import { Toaster as FxUIToaster } from "@foxui/core";

  import { fade } from "svelte/transition";
  import LoginForm from "$lib/components/user/LoginForm.svelte";
  import { TooltipProvider } from "@foxui/core";

  import { IconLoading } from "@roomy/design/icons";
  import Error from "$lib/components/modals/Error.svelte";
  import { AppState, setAppState } from "$lib/queries";

  const app = new AppState();
  setAppState(app);

  // Cache the current profile for use in the LoginForm to preview the last login.
  $effect(() => {
    if (
      peerStatus.authState?.state === "authenticated" &&
      peerStatus.profile &&
      localStorage.getItem("just-logged-in") != undefined
    ) {
      localStorage.setItem(
        `last-login`,
        JSON.stringify({
          handle: peerStatus.profile.handle,
          did: peerStatus.authState.did,
          avatar: peerStatus.profile.avatar,
        }),
      );
      localStorage.removeItem("just-logged-in");
    }
  });

  // The loading icon, though, should only show up if auth loading takes more than a short time, so
  // that it doesn't show up and disappear immediately which looks weirder than a nice fade-in.
  let showLoadingIcon = $state(false);
  onMount(() => {
    setTimeout(() => (showLoadingIcon = true), 200);
  });

  let { children } = $props();
</script>

<svelte:head>
  {#if dev}
    <!-- replaces favicon on dev, to easily spot difference between deployed and dev versions -->
    <link
      rel="icon"
      href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>👷‍♀️</text></svg>"
    />
  {/if}
</svelte:head>

{#if dev}
  <!-- Displays rendering scanner for debugging.
       Uncomment then recomment before committing. -->
  <!-- <RenderScan /> -->
{/if}

{#if peerStatus.authState?.state === "unauthenticated"}
  <!-- Login Form -->
  <div
    class="flex h-screen w-full items-center justify-center bg-base-950/75 bg fixed left-0 top-0 z-10"
  >
    <LoginForm class="w-[23em] bg-base-300 dark:bg-base-950 border-base-900 pt-6" />
  </div>
{/if}

<!-- Loading overlay -->
{#if peerStatus.authState?.state === "loading"}
  <div
    class="flex h-screen w-screen justify-center items-center fixed top-0 left-0 bg-base-50 dark:bg-base-950 z-50"
    transition:fade
  >
    {#if showLoadingIcon}
      <div transition:fade={{ duration: 500 }}>
        <IconLoading font-size="8em" class="animate-spin text-primary" />
      </div>
    {/if}
  </div>
{/if}

{#if peerStatus.authState?.state === "authenticated"}
  <!-- Page Content -->
  <TooltipProvider>
    {@render children?.()}
  </TooltipProvider>
{/if}

{#if peerStatus.authState?.state === "error"}
  <Error message={peerStatus.authState.error} />
{/if}

<FxUIToaster />
