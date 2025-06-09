<script lang="ts">
  import { onMount, setContext } from "svelte";
  import { browser, dev } from "$app/environment";
  import {
    AccountCoState,
    useIsAuthenticated,
    usePassphraseAuth,
  } from "jazz-svelte";
  import posthog from "posthog-js";
  import toast, { Toaster } from "svelte-french-toast";

  // @ts-ignore used for debugging
  import { RenderScan } from "svelte-render-scan";

  import { user } from "$lib/user.svelte";
  import { Toggle, setTheme } from "$lib/utils.svelte";
  import { type ThemeName } from "$lib/themes.ts";
  import ServerBar from "$lib/components/ServerBar.svelte";
  import SidebarMain from "$lib/components/SidebarMain.svelte";
  import { page } from "$app/state";
  import { afterNavigate } from "$app/navigation";
  import { LastReadList, RoomyAccount } from "$lib/jazz/schema";
  import "jazz-inspector-element";
  import { createInbox } from "$lib/jazz/utils";
  import { wordlist } from "$lib/jazz/wordlist";

  const { children } = $props();

  const me = new AccountCoState(RoomyAccount, {
    resolve: {
      profile: true,
      root: true,
    },
  });

  $effect(() => {
    if (!user.profile.data?.handle || !me.current) return;

    if (me.current.profile.name !== user.profile.data?.handle) {
      me.current.profile.name = user.profile.data?.handle;
    }

    if (me.current.profile.imageUrl !== user.profile.data?.avatar) {
      me.current.profile.imageUrl = user.profile.data?.avatar;
    }

    if (me.current.profile.blueskyHandle !== user.profile.data?.handle) {
      me.current.profile.blueskyHandle = user.profile.data?.handle;
    }

    if (me.current.profile.bannerUrl !== user.profile.data?.banner) {
      me.current.profile.bannerUrl = user.profile.data?.banner;
    }

    if (me.current.profile.description !== user.profile.data?.description) {
      me.current.profile.description = user.profile.data?.description;
    }
  });

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
    setLastRead();

    if (
      page.params.space &&
      (page.params.channel || page.params.thread) &&
      isSidebarVisible.value
    )
      isSidebarVisible.toggle();
  });

  function setLastRead() {
    if (!me?.current?.root) return;

    if (!me?.current?.root?.lastRead) {
      me.current.root.lastRead = LastReadList.create({});
    }

    if (page.params.channel) {
      me.current.root.lastRead[page.params.channel] = new Date();
    }

    if (page.params.thread) {
      me.current.root.lastRead[page.params.thread] = new Date();
    }
  }

  const auth = usePassphraseAuth({
    wordlist,
  });
  let passphrase = $state("");
</script>

<svelte:head>
  <meta name="theme-color" content={themeColor} />
  <meta name="msapplication-navbutton-color" content={themeColor} />
  <meta name="msapplication-TileColor" content={themeColor} />
  <title>Roomy</title>
</svelte:head>

{#if auth.state === "anonymous"}
  <div class="fixed top-0 left-0 w-full h-full bg-black/50 z-50">
    <div class="flex flex-col items-center justify-center h-full gap-2">
      <h1 class="text-2xl font-bold text-primary text-center">Passphrase Login</h1>
      <button
        class="dz-btn dz-btn-secondary"
        onclick={() => {
          const passphrase = auth.generateRandomPassphrase();

          auth.registerNewAccount(passphrase, "New Account");

          // copy passphrase to clipboard
          navigator.clipboard.writeText(passphrase);

          toast.success("Passphrase copied to clipboard");
        }}>New account with random passphrase</button
      >
      <input type="text" bind:value={passphrase} class="dz-input dz-input-bordered" />
      <button
        class="dz-btn dz-btn-primary"
        onclick={async () => {
          await auth.logIn(passphrase);

          // reload page
          location.reload();
        }}>Login</button
      >
    </div>
  </div>
{/if}

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
        spaces={me.current?.profile.joinedSpaces}
        visible={isSpacesVisible.value || !page.params.space}
        me={me.current}
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
