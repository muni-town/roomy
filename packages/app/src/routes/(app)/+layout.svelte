<script lang="ts">
  import "../../app.css";
  import { onMount, setContext } from "svelte";
  import { browser, dev } from "$app/environment";

  import posthog from "posthog-js";
  import { Toaster } from "svelte-french-toast";

  // @ts-ignore used for debugging
  import { RenderScan } from "svelte-render-scan";

  import { globalState } from "$lib/global.svelte";
  import { user } from "$lib/user.svelte";
  import { derivePromise, Toggle, setTheme } from "$lib/utils.svelte";
  import { type ThemeName } from "$lib/themes.ts";
  import ServerBar from "$lib/components/ServerBar.svelte";
  import SidebarMain from "$lib/components/SidebarMain.svelte";
  import { page } from "$app/state";
  import { afterNavigate } from "$app/navigation";

  const { children } = $props();
  const spaces = derivePromise(
    [],
    async () => (await globalState.roomy?.spaces.items()) || [],
  );

  let themeColor = $state<ThemeName>("synthwave"); // defualt theme color

  onMount(async () => {
    await user.init();

    // Set the theme color based on local storage
    const storedColor = window.localStorage.getItem("theme") as ThemeName;
    if (storedColor) {
      themeColor = storedColor;
    }

    setTheme(themeColor);
    // set color on data-theme for DaisyUI and theme-color meta tag for mobile
    document.documentElement.setAttribute("data-theme", themeColor);
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", themeColor);

    // Initialize PostHog for analytics
    if (!dev && browser) {
      posthog.init("phc_j80ksIuoxjfjRI7rPBmTLWx79rntg4Njz6Dixc3I3ik", {
        api_host: "https://roomy.chat/ingest",
        person_profiles: "identified_only", // or 'always' to create profiles for anonymous users as well
      });
    }
  });

  const isSpacesVisible = Toggle({ value: false, key: "isSpacesVisible" });
  setContext("isSpacesVisible", isSpacesVisible);

  const isSidebarVisible = Toggle({ value: false, key: "isSidebarVisible" });
  setContext("isSidebarVisible", isSidebarVisible);
  // hide on navigation
  afterNavigate(() => {
    if (
      page.params.space &&
      (page.params.channel || page.params.thread) &&
      isSidebarVisible.value
    )
      isSidebarVisible.toggle();
  });
</script>

<svelte:head>
  <meta name="theme-color" content={themeColor} />
  <meta name="msapplication-navbutton-color" content={themeColor} />
  <meta name="msapplication-TileColor" content={themeColor} />
  <title>Roomy</title>
</svelte:head>

{#if dev}
  <!-- Displays rendering scanner for debugging.
       Uncomment then recomment before committing. -->
  <!-- <RenderScan /> -->
{/if}

<!-- Container -->
<div class="flex w-screen h-screen max-h-screen overflow-clip gap-0">
  <Toaster />
  <div
    class="{page.params.space &&
      (isSidebarVisible.value
        ? 'flex z-1 absolute w-full'
        : 'hidden')} sm:w-auto sm:relative sm:flex h-full overflow-clip gap-0
      "
  >
    <!-- Content -->
    <div class="flex bg-base-100 h-full">
      <ServerBar
        {spaces}
        visible={isSpacesVisible.value || !page.params.space}
      />
      {#if page.params.space}
        <SidebarMain />
      {/if}
    </div>
    <!-- Overlay -->
    {#if page.params.space}
      <button
        onclick={() => {
          isSidebarVisible.toggle();
        }}
        aria-label="toggle navigation"
        class="{!isSidebarVisible.value
          ? 'hidden w-full'
          : 'sm:hidden'} cursor-pointer grow-2 h-full bg-black/10"
      ></button>
    {/if}
  </div>

  {@render children()}
</div>
