<script lang="ts">
  import { globalState } from "$lib/global.svelte";
  import { user } from "$lib/user.svelte";
  import { navigate } from "$lib/utils.svelte";
  import { Button } from "bits-ui";
  import Icon from "@iconify/svelte";
  import Dialog from "$lib/components/Dialog.svelte";
  import AvatarImage from "$lib/components/AvatarImage.svelte";
  import ThemeSelector from "$lib/components/ThemeSelector.svelte";
  import SidebarSpace from "$lib/components/SidebarSpace.svelte";
  import { Space } from "@roomy-chat/sdk";
  import { cleanHandle } from "$lib/utils.svelte";
  import { atproto } from "$lib/atproto.svelte";
  import { focusOnRender } from "$lib/actions/useFocusOnRender.svelte";
  import { env } from "$env/dynamic/public";

  let {
    spaces,
    visible,
  }: {
    spaces: { value: Space[] };
    visible: boolean;
  } = $props();

  let handleInput = $state("");
  let loginLoading = $state(false);
  let signupLoading = $state(false);
  const loadingAuth = $derived(signupLoading || loginLoading);

  let newSpaceName = $state("");
  let isNewSpaceDialogOpen = $state(false);

  async function createSpace() {
    if (!newSpaceName || !user.agent || !globalState.roomy) return;
    const space = await globalState.roomy.create(Space);
    space.name = newSpaceName;
    space.admins((x) => user.agent && x.push(user.agent.assertDid));
    space.commit();

    globalState.roomy.spaces.push(space);
    globalState.roomy.commit();
    newSpaceName = "";

    isNewSpaceDialogOpen = false;
  }

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
</script>

<!-- Width manually set for transition to w-0 -->
<aside
  class="flex flex-col justify-between align-center h-full {visible
    ? 'w-[60px] px-1 border-r-2'
    : 'w-[0]'} py-2 border-base-200 bg-base-300 transition-[width] duration-100 ease-out"
  class:opacity-0={!visible}
>
  <div class="flex flex-col gap-1 items-center">
    <button
      type="button"
      onclick={() => navigate("home")}
      class="dz-btn dz-btn-ghost px-1 w-full aspect-square"
    >
      <Icon icon="iconamoon:home-fill" font-size="1.75em" />
    </button>

    {#if user.session}
      <Dialog
        title="Create Space"
        description="Create a new public chat space"
        bind:isDialogOpen={isNewSpaceDialogOpen}
      >
        {#snippet dialogTrigger()}
          <Button.Root
            title="Create Space"
            class="p-2 aspect-square rounded-lg hover:bg-base-200 cursor-pointer"
          >
            <Icon icon="basil:add-solid" font-size="2em" />
          </Button.Root>
        {/snippet}

        <form
          id="createSpace"
          class="flex flex-col gap-4"
          onsubmit={createSpace}
        >
          <input
            bind:value={newSpaceName}
            use:focusOnRender
            placeholder="Name"
            class="dz-input w-full"
            type="text"
            required
          />
          <Button.Root disabled={!newSpaceName} class="dz-btn dz-btn-primary">
            <Icon icon="basil:add-outline" font-size="1.8em" />
            Create Space
          </Button.Root>
        </form>
      </Dialog>
    {/if}

    <div class="divider my-0"></div>

    {#each spaces.value as space, i}
      <SidebarSpace {space} {i} />
    {/each}
  </div>

  <section class="flex flex-col items-center gap-2 p-0">
    <!-- Only expose Discord import in dev with a flag for now. -->
    {#if env.PUBLIC_ENABLE_DISCORD_IMPORT == "true"}
      <Button.Root
        title="Import Discord Archive"
        class="p-2 aspect-square rounded-lg hover:bg-base-200 cursor-pointer"
        disabled={!user.session}
        href="/discord-import"
      >
        <Icon icon="mdi:folder-upload-outline" font-size="1.8em" />
      </Button.Root>
    {/if}

    <ThemeSelector />
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
          <Icon
            icon="simple-icons:bluesky"
            width="16"
            height="16"
          />Authenticate with Bluesky
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
  </section>
</aside>
