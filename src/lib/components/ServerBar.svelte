<script lang="ts">
  import { g } from "$lib/global.svelte";
  import { user } from "$lib/user.svelte";
  import { navigate } from "$lib/utils.svelte";
  import { Button, ToggleGroup } from "bits-ui";
  import Icon from "@iconify/svelte";
  import Dialog from "$lib/components/Dialog.svelte";
  import AvatarImage from "$lib/components/AvatarImage.svelte";
  import ThemeSelector from "$lib/components/ThemeSelector.svelte";
  import SidebarSpace from "$lib/components/SidebarSpace.svelte";
  import { Space } from "@roomy-chat/sdk";
  import { cleanHandle } from "$lib/utils.svelte";

  let {
    spaces,
    visible,
  }: {
    spaces: { value: Space[] };
    visible: boolean;
  } = $props();

  let handleInput = $state("");
  let loginLoading = $state(false);

  let newSpaceName = $state("");
  let isNewSpaceDialogOpen = $state(false);

  // Removed auto-popup effect to only show login dialog when user clicks avatar

  async function createSpace() {
    if (!newSpaceName || !user.agent || !g.roomy) return;
    const space = await g.roomy.create(Space);
    space.name = newSpaceName;
    space.admins((x) => user.agent && x.push(user.agent.assertDid));
    space.commit();

    g.roomy.spaces.push(space);
    g.roomy.commit();
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
</script>

<!-- Width manually set for transition to w-0 -->
<aside
  class="flex flex-col justify-between align-center h-full {visible
    ? 'w-[60px] px-1 border-r-2'
    : 'w-[0]'} py-2 border-base-200 bg-base-300 transition-[width] duration-100 ease-out"
  class:opacity-0={!visible}
>
  <ToggleGroup.Root
    type="single"
    value={g.currentCatalog}
    class="flex flex-col gap-1 items-center"
  >
    <ToggleGroup.Item
      value="home"
      onclick={() => navigate("home")}
      class="dz-btn dz-btn-ghost px-1 w-full aspect-square data-[state=on]:border-accent"
    >
      <Icon icon="iconamoon:home-fill" font-size="1.75em" />
    </ToggleGroup.Item>

    <div class="divider my-0"></div>

    {#each spaces.value as space, i}
      <SidebarSpace {space} {i} />
    {/each}
  </ToggleGroup.Root>

  <section class="flex flex-col items-center gap-2 p-0">
    <ThemeSelector />
    <Dialog
      title="Create Space"
      description="Create a new public chat space"
      bind:isDialogOpen={isNewSpaceDialogOpen}
      disabled={!user.session}
    >
      {#snippet dialogTrigger()}
        <Button.Root
          title="Create Space"
          class="p-2 aspect-square rounded-lg hover:bg-base-200 cursor-pointer"
          disabled={!user.session}
        >
          <Icon icon="basil:add-solid" font-size="2em" />
        </Button.Root>
      {/snippet}

      <form class="flex flex-col gap-4" onsubmit={createSpace}>
        <input
          bind:value={newSpaceName}
          placeholder="Name"
          class="dz-input w-full"
        />
        <Button.Root disabled={!newSpaceName} class="dz-btn dz-btn-primary">
          <Icon icon="basil:add-outline" font-size="1.8em" />
          Create Space
        </Button.Root>
      </form>
    </Dialog>

    <Dialog
      title={user.session ? "Log Out" : "Log In"}
      description={user.session
        ? `Logged in as ${user.profile.data?.handle}`
        : "Log in with AT Protocol"}
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
        <form class="flex flex-col gap-4" onsubmit={login}>
          {#if loginError}
            <p class="text-error">{loginError}</p>
          {/if}
          <input
            bind:value={handleInput}
            placeholder="Handle (eg alice.bsky.social)"
            class="dz-input w-full"
          />
          <Button.Root
            disabled={loginLoading || !handleInput}
            class="dz-btn dz-btn-primary"
          >
            {#if loginLoading}
              <span class="dz-loading dz-loading-spinner"></span>
            {/if}
            Log In with Bluesky
          </Button.Root>
        </form>
      {/if}
    </Dialog>
  </section>
</aside>
