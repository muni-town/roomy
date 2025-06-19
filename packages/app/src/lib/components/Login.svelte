<script lang="ts">
  import { atproto } from "$lib/atproto.svelte";
  import { user } from "$lib/user.svelte";
  import { cleanHandle } from "$lib/utils.svelte";
  import { Button } from "bits-ui";
  import AvatarImage from "$lib/components/AvatarImage.svelte";
  import Dialog from "$lib/components/Dialog.svelte";
  import Icon from "@iconify/svelte";
  import { onMount } from "svelte";

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

  onMount(() => {
    // Autofill handle input with last used handle if available and input is empty
    const lastHandle = user.getLastUsedHandle();
    if (!handleInput && lastHandle) {
      handleInput = lastHandle;
    }
  });
</script>

<Dialog
  title={user.session ? "Log Out" : "Create Account or Log In"}
  description={user.session
    ? `Logged in as ${user.profile.data?.handle}`
    : `We use the AT Protocol to authenticate users <a href="https://atproto.com/guides/identity" class="text-primary hover:text-primary/75"> learn more </a>`}
  bind:isDialogOpen={user.isLoginDialogOpen}
>
  {#snippet dialogTrigger()}
    <AvatarImage
      className="p-1 w-full cursor-pointer"
      handle={user.profile.data?.handle || ""}
      avatarUrl={user.profile.data?.avatar}
    />
  {/snippet}

  {#if user.session}
    <section class="flex flex-col gap-4">
      <Button.Root onclick={user.logout} class="dz-btn dz-btn-error">
        Log Out
      </Button.Root>
    </section>
  {:else}
    <Button.Root
      onclick={signup}
      disabled={loadingAuth}
      class="dz-btn dz-btn-primary"
    >
      {#if signupLoading}
        <span class="dz-loading dz-loading-spinner"></span>
      {/if}
      <Icon icon="simple-icons:bluesky" width="16" height="16" />Authenticate
      with Bluesky
    </Button.Root>
    <p class="text-sm pt-4">Know your handle? Log in with it below.</p>
    <form class="flex flex-col gap-4" onsubmit={login}>
      {#if loginError}
        <p class="text-error">{loginError}</p>
      {/if}
      <input
        bind:value={handleInput}
        placeholder="Handle (eg alice.bsky.social)"
        class="dz-input w-full"
        type="text"
        id="handle"
        required
      />
      <Button.Root
        disabled={loadingAuth || !handleInput}
        class="dz-btn dz-btn-primary"
      >
        {#if loginLoading}
          <span class="dz-loading dz-loading-spinner"></span>
        {/if}
        Log in with bsky.social
      </Button.Root>
    </form>

    <p class="text-sm text-center pt-4 text-base-content/50">
      More options coming soon!
    </p>
  {/if}
</Dialog>
