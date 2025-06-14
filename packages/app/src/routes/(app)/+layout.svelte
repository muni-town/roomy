<script lang="ts">
  import { onMount, setContext } from "svelte";
  import { browser, dev } from "$app/environment";
  import { AccountCoState, usePassphraseAuth } from "jazz-svelte";
  import posthog from "posthog-js";
  import { Toaster } from "svelte-french-toast";

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
  import { wordlist } from "$lib/jazz/wordlist";
  import { addToAllAccountsList } from "$lib/jazz/utils";

  const me = new AccountCoState(RoomyAccount, {
    resolve: {
      profile: true,
      root: true,
    },
  });
  const { children } = $props();

  const auth = usePassphraseAuth({ wordlist });

  async function logIn(passphrase: string, handle: string) {
    try {
      await auth.logIn(passphrase);
    } catch (e) {
      console.error(
        "Error logging in, trying to register new account instead.",
      );
      auth.registerNewAccount(passphrase, handle);
    }
  }

  async function setProfileRecord(accountId?: string, profileId?: string) {
    if (!accountId || !profileId) return false;

    await user.agent?.com.atproto.repo.createRecord({
      collection: "chat.roomy.profile",
      record: { accountId, profileId },
      repo: user.agent.assertDid,
      rkey: "self",
    });

    addToAllAccountsList(accountId);

    return true;
  }

  async function removeProfileRecord() {
    await user.agent?.com.atproto.repo.deleteRecord({
      collection: "chat.roomy.profile",
      repo: user.agent.assertDid,
      rkey: "self",
    });
  }

  async function checkProfileRecord() {
    try {
      await user.agent?.com.atproto.repo.getRecord({
        collection: "chat.roomy.profile",
        repo: user.agent.assertDid,
        rkey: "self",
      });

      recordChecked = true;
    } catch (e) {
      recordChecked = await setProfileRecord(me.current?.id, me.current?.profile.id);
    }
  }

  let recordChecked = $state(false);

  $effect(() => {
    if (user.agent && !recordChecked && auth.state === "signedIn") {
      checkProfileRecord();
    }
  });

  $effect(() => {
    if (
      user.passphrase.value &&
      user.profile.data &&
      auth.state === "anonymous"
    ) {
      logIn(user.passphrase.value, user.profile.data.handle);
    }
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
        api_host: "https://roomy.space/ingest",
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
    if (!page.params.space) return;

    if (!me?.current?.root) return;

    if (!me?.current?.root?.lastRead === null) {
      me.current.root.lastRead = LastReadList.create({});
    }

    if (!me.current.root.lastRead) return;

    if (page.params.channel) {
      me.current.root.lastRead[page.params.channel] = new Date();
    }

    if (page.params.thread) {
      me.current.root.lastRead[page.params.thread] = new Date();
    }
  }
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
