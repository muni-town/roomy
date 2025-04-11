<script lang="ts">
  import "../../app.css";
  import { user } from "$lib/user.svelte";
  import { cleanHandle } from "$lib/utils.svelte";

  import Dialog from "$lib/components/Dialog.svelte";
  import AvatarImage from "$lib/components/AvatarImage.svelte";
  import { Button } from "bits-ui";

  let handleInput = $state("");
  let loginLoading = $state(false);
  let {
    class: classNames = "",
  }: {
    class?: string;
  } = $props();

  let isLoginDialogOpen = $state(!user.session);
  $effect(() => {
    if (user.session) isLoginDialogOpen = false;
  });

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
</script>

<Dialog
  title={user.session ? "Log Out" : "Log In"}
  description={user.session
    ? `Logged in as ${user.profile.data?.handle}`
    : "Log in with AT Protocol"}
  bind:isDialogOpen={isLoginDialogOpen}
>
  {#snippet dialogTrigger()}
    <Button.Root class="btn btn-ghost w-fit {classNames}">
      <AvatarImage
        handle={user.profile.data?.handle || ""}
        avatarUrl={user.profile.data?.avatar}
      />
    </Button.Root>
  {/snippet}

  {#if user.session}
    <section class="flex flex-col gap-4">
      <Button.Root onclick={user.logout} class="btn btn-error">
        Log Out
      </Button.Root>
    </section>
  {:else}
    <form class="flex flex-col gap-4" onsubmit={login}>
      {#if loginError}
        <p class="text-error">{loginError}</p>
      {/if}
      <input
        bind:value={handleInput}
        placeholder="Handle (eg alice.bsky.social)"
        class="input w-full"
      />
      <Button.Root
        disabled={loginLoading || !handleInput}
        class="btn btn-primary"
      >
        {#if loginLoading}
          <span class="loading loading-spinner"></span>
        {/if}
        Log In with Bluesky
      </Button.Root>
    </form>
  {/if}
</Dialog>
