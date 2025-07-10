<script lang="ts">
  import { onMount, setContext } from "svelte";
  import { browser, dev } from "$app/environment";
  import { AccountCoState, usePassphraseAuth } from "jazz-svelte";
  import posthog from "posthog-js";
  import { Toaster } from "svelte-french-toast";

  // @ts-ignore used for debugging
  import { RenderScan } from "svelte-render-scan";

  import { user } from "$lib/user.svelte";
  import { Toggle } from "$lib/utils.svelte";
  import { page } from "$app/state";
  import { afterNavigate } from "$app/navigation";
  import {
    LastReadList,
    RoomyAccount,
    wordlist,
    addToAllAccountsList,
    setInviteServiceUrl,
  } from "@roomy-chat/sdk";
  import { PUBLIC_INVITE_SERVICE_URL } from "$env/static/public";

  const me = new AccountCoState(RoomyAccount, {
    resolve: {
      profile: true,
      root: true,
    },
  });

  $effect(() => {
    if (me.current) {
      setInviteServiceUrl(PUBLIC_INVITE_SERVICE_URL);
    }
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

  // only used for testing
  // async function removeProfileRecord() {
  //   await user.agent?.com.atproto.repo.deleteRecord({
  //     collection: "chat.roomy.profile",
  //     repo: user.agent.assertDid,
  //     rkey: "self",
  //   });
  // }

  async function checkProfileRecord() {
    try {
      await user.agent?.com.atproto.repo.getRecord({
        collection: "chat.roomy.profile",
        repo: user.agent.assertDid,
        rkey: "self",
      });

      recordChecked = true;
    } catch (e) {
      recordChecked = await setProfileRecord(
        me.current?.id,
        me.current?.profile.id,
      );
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

  onMount(async () => {
    await user.init();

    // Initialize PostHog for analytics
    if (!dev && browser) {
      posthog.init("phc_j80ksIuoxjfjRI7rPBmTLWx79rntg4Njz6Dixc3I3ik", {
        api_host: "https://hog.roomy.space/",
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

{#if dev}
  <!-- Displays rendering scanner for debugging.
       Uncomment then recomment before committing. -->
  <!-- <RenderScan /> -->
{/if}

<Toaster />

{@render children()}
