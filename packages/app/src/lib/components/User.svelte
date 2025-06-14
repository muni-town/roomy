<script lang="ts">
  import { atproto } from "$lib/atproto.svelte";
  import { user } from "$lib/user.svelte";
  import { cleanHandle } from "$lib/utils.svelte";
  import { Button } from "bits-ui";
  import AvatarImage from "$lib/components/AvatarImage.svelte";
  import Dialog from "$lib/components/Dialog.svelte";
  import Icon from "@iconify/svelte";
  import { Avatar } from "@fuxui/base";
  import { blueskyLoginModalState } from "@fuxui/social";
  import UserSettingsModal from "./modals/UserSettingsModal.svelte";

  let handleInput = $state("");
  let loginLoading = $state(false);
  let signupLoading = $state(false);
  const loadingAuth = $derived(signupLoading || loginLoading);

  let loginError = $state("");

  async function login() {
    loginLoading = true;

    try {
      handleInput = cleanHandle(handleInput);
      await user.loginWithHandle(handleInput);
    } catch (e: unknown) {
      console.error(e);
      loginError = e instanceof Error ? e.message.toString() : "Unknown error";
    }

    loginLoading = false;
  }

  async function signup() {
    signupLoading = true;
    try {
      await atproto.oauth.signIn("https://bsky.social");
    } catch (e: unknown) {
      console.error(e);
      loginError = e instanceof Error ? e.message.toString() : "Unknown error";
    }
    signupLoading = false;
  }

  let userSettingsModalOpen = $state(false);
</script>

<button
  onclick={() => {
    if (user.session) {
      userSettingsModalOpen = true;
    } else {
      blueskyLoginModalState.open = true;
    }
  }}
  class="cursor-pointer"
>
  <Avatar src={user.profile.data?.avatar} fallback={user.profile.data?.handle}
  ></Avatar>
  {#if user.session}
    <span class="sr-only">{user.profile.data?.handle}</span>
  {:else}
    <span class="sr-only">Log in</span>
  {/if}
</button>

<UserSettingsModal bind:open={userSettingsModalOpen} />
