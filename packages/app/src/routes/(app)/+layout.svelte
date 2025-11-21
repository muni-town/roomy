<script lang="ts">
  import "../../app.css";
  import { browser, dev } from "$app/environment";
  import posthog from "posthog-js";
  import { backendStatus } from "$lib/workers";
  import { onMount } from "svelte";
  import { Alert, Toaster as FxUIToaster } from "@fuxui/base";

  import { fade } from "svelte/transition";
  import LoginForm from "$lib/components/user/LoginForm.svelte";
  import { TooltipProvider } from "@fuxui/base";

  import IconMdiLoading from "~icons/mdi/loading";

  onMount(async () => {
    // Initialize PostHog for analytics
    if (!dev && browser && globalThis.location.hostname == "roomy.space") {
      posthog.init("phc_j80ksIuoxjfjRI7rPBmTLWx79rntg4Njz6Dixc3I3ik", {
        api_host: "https://hog.roomy.space/",
        person_profiles: "identified_only", // or 'always' to create profiles for anonymous users as well
      });
    }
  });

  // Cache the current profile for use in the LoginForm to preview the last login.
  $effect(() => {
    if (
      backendStatus.authState?.state === "authenticated" &&
      backendStatus.profile &&
      localStorage.getItem("just-logged-in") != undefined
    ) {
      localStorage.setItem(
        `last-login`,
        JSON.stringify({
          handle: backendStatus.profile.handle,
          did: backendStatus.authState.did,
          avatar: backendStatus.profile.avatar,
        }),
      );
      localStorage.removeItem("just-logged-in");
    }
  });

  $effect(() => {
    console.log("authState", backendStatus.authState);
    console.log("profile", backendStatus.profile);
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

{#if backendStatus.authState?.state === "unauthenticated"}
  <!-- Login Form -->
  <div
    class="flex h-screen w-full items-center justify-center bg-base-950/75 bg fixed left-0 top-0 z-10"
  >
    <LoginForm class="w-[23em] bg-base-300" />
  </div>
{/if}

<!-- Loading overlay -->
{#if backendStatus.authState?.state === "loading"}
  <div
    class="flex h-screen w-screen justify-center items-center fixed top-0 left-0 bg-base-50 dark:bg-base-950 z-50"
    transition:fade
  >
    {#if showLoadingIcon}
      <div transition:fade={{ duration: 500 }}>
        <IconMdiLoading font-size="8em" class="animate-spin text-primary" />
      </div>
    {/if}
  </div>
{/if}

{#if backendStatus.authState?.state === "authenticated"}
  <!-- Page Content -->
  <TooltipProvider>
    {@render children?.()}
  </TooltipProvider>
{/if}

{#if backendStatus.authState?.state === "error"}
  <div class="w-full h-screen flex items-center justify-center">
    <Alert title="Authentication Error" type="error" class="max-w-sm">
      <h6>Something went wrong trying to get you logged in.</h6>
      <pre class="my-2 opacity-80">{backendStatus.authState?.error}</pre>
      <span
        >You can let us know on <a
          href="https://github.com/muni-town/roomy/issues/new"
          class="text-accent-600 dark:text-accent-200">Github</a
        >,
        <a
          href="https://discord.gg/bGMESxp7ff"
          class="text-accent-600 dark:text-accent-200">Discord</a
        >
        or
        <a
          href="https://bsky.app/profile/roomy.space"
          class="text-accent-600 dark:text-accent-200">Bluesky</a
        ></span
      >
    </Alert>
  </div>
{/if}

<FxUIToaster />
