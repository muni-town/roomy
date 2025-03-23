<script lang="ts">
  import "../../app.css";
  import { onMount, untrack } from "svelte";
  import { page } from "$app/state";
  import { dev } from "$app/environment";
  import { goto } from "$app/navigation";
  import { g } from "$lib/global.svelte";
  import { user } from "$lib/user.svelte";
  import { cleanHandle, derivePromise } from "$lib/utils.svelte";

  import Icon from "@iconify/svelte";
  import Dialog from "$lib/components/Dialog.svelte";
  import AvatarImage from "$lib/components/AvatarImage.svelte";

  import { Toaster } from "svelte-french-toast";
  import { RenderScan } from "svelte-render-scan";
  import { AvatarMarble } from "svelte-boring-avatars";
  import { Avatar, Button, ToggleGroup } from "bits-ui";

  import ThemeSelector from "$lib/components/ThemeSelector.svelte";
  import { Channel, Space, Thread, type EntityIdStr } from "@roomy-chat/sdk";

  let { children } = $props();

  let handleInput = $state("");
  let loginLoading = $state(false);
  let isLoginDialogOpen = $state(!user.session);

  let newSpaceName = $state("");
  let isNewSpaceDialogOpen = $state(false);

  let spaces = derivePromise([], () => g.roomy.spaces.items());
  let currentCatalog = $state("");

  /** Update the global space and channel when the route changes. */
  $effect(() => {
    if (page.url.pathname === "/home") {
      currentCatalog = "home";
      g.space = undefined;
    } else if (page.params.space) {
      try {
        g.roomy
          .open(Space, page.params.space as EntityIdStr)
          .then((space) => untrack(() => (g.space = space)));

        currentCatalog = page.params.space;
      } catch (e) {
        console.error("Error opening space:", e);
        goto("/");
      }
    } else {
      g.space = undefined;
    }
  });

  $effect(() => {
    if (g.space && page.params.channel) {
      try {
        g.roomy
          .open(Channel, page.params.channel as EntityIdStr)
          .then((channel) => untrack(() => (g.channel = channel)));
      } catch (e) {
        console.error("Error opening channel:", e);
        goto("/");
      }
    } else if (g.space && page.params.thread) {
      try {
        g.roomy
          .open(Thread, page.params.thread as EntityIdStr)
          .then((thread) => untrack(() => (g.channel = thread)));
      } catch (e) {
        console.error("Error opening thread:", e);
        goto("/");
      }
    } else {
      g.channel = undefined;
    }
  });

  $effect(() => {
    if (g.space && user.agent) {
      g.isAdmin = g.space.admins.toArray().includes(user.agent.assertDid);
    } else {
      g.isAdmin = false;
    }
  });

  onMount(async () => {
    await user.init();
  });

  $effect(() => {
    if (user.session) isLoginDialogOpen = false;
  });

  async function createSpace() {
    if (!newSpaceName || !user.agent) return;
    const space = await g.roomy.create(Space);
    space.name = newSpaceName;
    space.admins.push(user.agent.assertDid);
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
    } catch (e: any) {
      console.error(e);
      loginError = e.toString();
    }

    loginLoading = false;
  }
</script>

<svelte:head>
  <title>Roomy</title>
</svelte:head>

{#if dev}
  <RenderScan />
{/if}

<!-- Container -->
<div class="flex w-screen h-screen bg-base-100">
  <Toaster />
  <!-- Server Bar -->

  <aside
    class="w-fit col-span-2 flex flex-col justify-between px-4 py-8 items-center border-r-2 border-base-200"
  >
    <ToggleGroup.Root
      type="single"
      value={currentCatalog}
      class="flex flex-col gap-2 items-center"
    >
      <ToggleGroup.Item
        value="home"
        onclick={() => goto("/home")}
        class="btn btn-ghost size-16 data-[state=on]:border-accent"
      >
        <Icon icon="iconamoon:home-fill" font-size="2em" />
      </ToggleGroup.Item>

      <div class="divider mt-0 mb-1"></div>

      {#each spaces.value as space}
        <ToggleGroup.Item
          onclick={() => goto(`/space/${space.id}`)}
          value={space.id}
          title={space.name}
          class="btn btn-ghost size-16 data-[state=on]:border-primary"
        >
          <!-- TODO: Use server avatar -->
          <Avatar.Root>
            <Avatar.Image />
            <Avatar.Fallback>
              <AvatarMarble name={space.id} />
            </Avatar.Fallback>
          </Avatar.Root>
        </ToggleGroup.Item>
      {/each}
    </ToggleGroup.Root>

    <section class="menu gap-3">
      <ThemeSelector />
      <Dialog
        title="Create Space"
        description="Create a new public chat space"
        bind:isDialogOpen={isNewSpaceDialogOpen}
      >
        {#snippet dialogTrigger()}
          <Button.Root title="Create Space" class="btn btn-ghost w-fit">
            <Icon icon="basil:add-solid" font-size="2em" />
          </Button.Root>
        {/snippet}

        <form class="flex flex-col gap-4" onsubmit={createSpace}>
          <input
            bind:value={newSpaceName}
            placeholder="Name"
            class="input w-full"
          />
          <Button.Root disabled={!newSpaceName} class="btn btn-primary">
            <Icon icon="basil:add-outline" font-size="1.8em" />
            Create Space
          </Button.Root>
        </form>
      </Dialog>

      <Dialog
        title={user.session
          ? `Logged In As ${user.profile.data?.handle}`
          : "Login with AT Protocol"}
        bind:isDialogOpen={isLoginDialogOpen}
      >
        {#snippet dialogTrigger()}
          <Button.Root class="btn btn-ghost w-fit">
            <AvatarImage
              handle={user.profile.data?.handle || ""}
              avatarUrl={user.profile.data?.avatar}
            />
          </Button.Root>
        {/snippet}

        {#if user.session}
          <section class="flex flex-col gap-4">
            <Button.Root onclick={user.logout} class="btn btn-error">
              Logout
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
              Login with Bluesky
            </Button.Root>
          </form>
        {/if}
      </Dialog>
    </section>
  </aside>

  {@render children()}
</div>
