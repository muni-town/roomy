<script lang="ts">
  import { AccountCoState, usePassphraseAuth } from "jazz-svelte";
  import { user } from "$lib/user.svelte";
  import { RoomyAccount } from "$lib/jazz/schema";
  import { wordlist } from "$lib/jazz/wordlist";
  import { addToAllAccountsList } from "$lib/jazz/utils";
  
  let { children } = $props();
  const me = new AccountCoState(RoomyAccount, {
    resolve: {
      profile: {
        joinedSpaces: {
          $each: true,
        },
      },
      root: true,
    },
  });

  const auth = usePassphraseAuth({ wordlist });

  async function logIn(passphrase: string, handle: string) {
    try {
      await auth.logIn(passphrase);
    } catch (e) {
      console.error("Error logging in, trying to register new account instead.");
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

  // Export the me object so it can be used by child components
  import { setContext } from 'svelte';
  setContext('jazzAccount', me);
</script>

{@render children?.()}
