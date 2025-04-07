<script lang="ts">
  import "../../app.css";
  import { onMount } from "svelte";
  import { dev } from "$app/environment";
  import { g } from "$lib/global.svelte";
  import { user } from "$lib/user.svelte";
  import { cleanHandle, derivePromise, navigate } from "$lib/utils.svelte";

  import Icon from "@iconify/svelte";
  import Dialog from "$lib/components/Dialog.svelte";
  import AvatarImage from "$lib/components/AvatarImage.svelte";

  import { Toaster } from "svelte-french-toast";
  import { RenderScan } from "svelte-render-scan";
  import { AvatarMarble } from "svelte-boring-avatars";
  import { Avatar, Button, Tabs, ToggleGroup } from "bits-ui";

  import ThemeSelector from "$lib/components/ThemeSelector.svelte";
  import { Space } from "@roomy-chat/sdk";
  import ContextMenu from "$lib/components/ContextMenu.svelte";
  import ChatMode from "$lib/components/ChatMode.svelte";
  import { page } from "$app/state";

  let { children } = $props();
  import { outerWidth } from "svelte/reactivity/window";

  let isMobile = $derived((outerWidth.current || 0) < 640);
  let handleInput = $state("");
  let loginLoading = $state(false);
  let isLoginDialogOpen = $state(!user.session);

  let newSpaceName = $state("");
  let isNewSpaceDialogOpen = $state(false);

  let spaces = derivePromise(
    [],
    async () => (await g.roomy?.spaces.items()) || [],
  );

  onMount(async () => {
    await user.init();
  });
  let tab = $state("index");

  $effect(() => {
    if (user.session) isLoginDialogOpen = false;
  });

  async function createSpace() {
    if (!newSpaceName || !user.agent || !g.roomy) return;
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
<div class="grid grid-rows-[2rem_1fr] gap-0 w-screen h-screen bg-base-100">
  <Toaster />

  <!-- Header -->
  <div class="w-full h-full flex items-center">
    <h1 class="px-4 py-1 text-sm font-medium text-base-content">
      <span class="font-bold">{g.space?.name}</span> / {g.channel?.name}
    </h1>
  </div>

  <div class="flex h-full w-screen overflow-y-auto bg-base-100 py-0">
    <!-- Server Bar -->
    <aside class="w-fit flex flex-col">
      <Tabs.Root bind:value={tab}>
        <Tabs.List class="flex ">
          <Tabs.Trigger value="index" class="tab flex gap-2">
            <Icon
              icon="material-symbols:thread-unread-rounded"
              class="text-2xl"
            />
          </Tabs.Trigger>
          <Tabs.Trigger value="chat" class="tab flex gap-2">
            <Icon icon="tabler:message" class="text-2xl" />
          </Tabs.Trigger>
        </Tabs.List>
      </Tabs.Root>

      {#if tab === "index"}
        <div
          class="w-fit h-full col-span-2 flex flex-col justify-between items-center"
        >
          <ToggleGroup.Root
            type="single"
            value={g.currentCatalog}
            class="flex flex-col gap-2 items-center"
          >
            <ToggleGroup.Item
              value="home"
              onclick={() => navigate("home")}
              class="btn btn-ghost size-15 data-[state=on]:border-accent"
            >
              <Icon icon="iconamoon:home-fill" font-size="2em" />
            </ToggleGroup.Item>

            <div class="divider mt-0 mb-1"></div>

            {#each spaces.value as space, i}
              <ContextMenu
                menuTitle={space.name}
                items={[
                  {
                    label: "Leave Space",
                    icon: "mdi:exit-to-app",
                    onselect: () => {
                      g.roomy?.spaces.remove(i);
                      g.roomy?.commit();
                    },
                  },
                ]}
              >
                <ToggleGroup.Item
                  onclick={() =>
                    navigate({ space: space.handles.get(0) || space.id })}
                  value={space.id}
                  title={space.name}
                  class="btn btn-ghost rounded-full size-11 data-[state=on]:border-primary"
                >
                  <Avatar.Root>
                    <Avatar.Image />
                    <Avatar.Fallback>
                      <AvatarMarble name={space.id} size={33} />
                    </Avatar.Fallback>
                  </Avatar.Root>
                </ToggleGroup.Item>
              </ContextMenu>
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
                  <Icon icon="basil:add-solid" font-size="1.5em" />
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
        </div>
      {:else if tab === "chat"}
        <ChatMode />
      {/if}
    </aside>

    {#if g.space}
          <main
            class="flex flex-col gap-4 rounded-lg p-4 overflow-clip bg-base-100 {!isMobile
              ? 'grow min-w-0 rounded-tl-2xl rounded-sm border-2 border-b-0 border-base-200'
              : page.params.channel || page.params.thread
                ? 'absolute inset-0'
                : 'hidden'}"
          >
            {@render children()}
          </main>
    {:else}
      <span class="loading loading-spinner mx-auto w-25"></span>
    {/if}
  </div>
</div>
