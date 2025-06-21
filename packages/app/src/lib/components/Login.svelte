<script lang="ts">
  import { atproto } from "$lib/atproto.svelte";
  import { user } from "$lib/user.svelte";
  import { cleanHandle } from "$lib/utils.svelte";
  import { Button } from "bits-ui";
  import AvatarImage from "$lib/components/AvatarImage.svelte";
  import Dialog from "$lib/components/Dialog.svelte";
  import Icon from "@iconify/svelte";

  let handleInput = $state("");
  let loginLoading = $state(false);
  let signupLoading = $state(false);
  const loadingAuth = $derived(signupLoading || loginLoading);

  let loginError = $state("");

  // Latest login state
  let latestLogin = $state<{ handle: string; avatarUrl?: string; displayName?: string } | null>(null);

  // UI feedback state
  let autofillActive = $state(false);
  let pulseLoginBtn = $state(false);

  // Load latest login from localStorage on mount
  $effect(() => {
    const saved = localStorage.getItem("latestLogin");
    if (saved) {
      try {
        latestLogin = JSON.parse(saved);
      } catch {}
    }
  });

  // Autofill handle when latest login is clicked
  function autofillHandle() {
    if (latestLogin) {
      handleInput = latestLogin.handle;
      autofillActive = true;
      pulseLoginBtn = true;
      setTimeout(() => {
        autofillActive = false;
      }, 900);
      setTimeout(() => {
        pulseLoginBtn = false;
      }, 900);
    }
  }

  async function login() {
    loginLoading = true;

    try {
      handleInput = cleanHandle(handleInput);
      await user.loginWithHandle(handleInput);
      // Note: Code after this point never executes due to redirect to Bluesky OAuth
      // Latest login info is already saved in user.svelte.ts when session is set
    } catch (e: unknown) {
      console.error(e);
      loginError = e instanceof Error ? e.message.toString() : "Unknown error";
      loginLoading = false;
    }
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
    <!-- Quick access section for latest login -->
    {#if latestLogin}
      <div class="flex flex-col gap-2 mb-4">
        <span class="text-base font-semibold">Quick access</span>
        <button type="button" class="flex items-center gap-3 rounded-xl border border-base-200 bg-base-100 px-4 py-2 hover:bg-base-200 transition" onclick={autofillHandle}>
          <AvatarImage
            className="size-8"
            handle={latestLogin.handle}
            avatarUrl={latestLogin.avatarUrl}
          />
          <span class="font-medium">{latestLogin.displayName || latestLogin.handle}</span>
          <span class="text-xs text-base-content/60 ml-2">{latestLogin.handle}</span>
        </button>
      </div>
    {/if}
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
        class={`dz-input w-full ${autofillActive ? 'ring-2 ring-primary/80 transition-all duration-300' : ''}`}
        type="text"
        id="handle"
        required
      />
      <Button.Root
        disabled={loadingAuth || !handleInput}
        class={`dz-btn dz-btn-primary ${pulseLoginBtn ? 'animate-pulse' : ''}`}
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
