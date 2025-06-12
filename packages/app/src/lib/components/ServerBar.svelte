<script lang="ts">
  import { user } from "$lib/user.svelte";
  import { navigate } from "$lib/utils.svelte";
  import { Button, Portal } from "bits-ui";
  import Icon from "@iconify/svelte";
  import Dialog from "$lib/components/Dialog.svelte";
  import ThemeSelector from "$lib/components/ThemeSelector.svelte";
  import SidebarSpace from "$lib/components/SidebarSpace.svelte";
  import { focusOnRender } from "$lib/actions/useFocusOnRender.svelte";
  import { env } from "$env/dynamic/public";
  import { co } from "jazz-tools";
  import { createSpace, createSpaceList } from "$lib/jazz/utils";
  import { RoomyAccount, Space, SpaceList } from "$lib/jazz/schema";
  import Login from "./Login.svelte";
  import { CoState } from "jazz-svelte";
  import { page } from "$app/state";
  import { page as pageStore } from "$app/stores";

  let {
    spaces,
    visible,
    me,
  }: {
    spaces: co.loaded<typeof SpaceList> | undefined | null;
    visible: boolean;
    me: co.loaded<typeof RoomyAccount> | undefined | null;
  } = $props();

  let newSpaceName = $state("");
  let isNewSpaceDialogOpen = $state(false);

  let openSpace = $derived(new CoState(Space, page.params.space));

  let isOpenSpaceJoined = $derived(
    me?.profile?.joinedSpaces?.some((x) => x?.id === openSpace.current?.id),
  );

  async function createSpaceSubmit(evt: Event) {
    evt.preventDefault();
    if (!newSpaceName) return;

    if (me?.profile && me.profile.joinedSpaces === undefined) {
      me.profile.joinedSpaces = createSpaceList();
    }

    const space = createSpace(newSpaceName);

    me?.profile?.joinedSpaces?.push(space);

    newSpaceName = "";

    isNewSpaceDialogOpen = false;

    console.log("navigating to space", space.id);
    navigate({ space: space.id });
  }
</script>

<!-- Width manually set for transition to w-0 -->
<aside
  class="flex flex-col justify-between align-center h-screen {visible
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

    <!-- Messages Button -->
    <a
      href="/messages"
      class={`p-2 aspect-square rounded-lg hover:bg-base-200 cursor-pointer relative transition-all duration-200
        ${$pageStore.url.pathname.startsWith('/messages') ? 'ring-0.5 ring-offset-0 ring-primary/30 border border-primary' : ''}`}
      title="Direct Messages"
    >
      <Icon icon="tabler:mail" font-size="1.75em" />
    </a>

    {#if me?.profile?.blueskyHandle}
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
          onsubmit={createSpaceSubmit}
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
    {#if !isOpenSpaceJoined && openSpace.current}
      <SidebarSpace space={openSpace.current} hasJoined={false} {me} />
    {/if}
  </div>
  <div class="flex flex-col gap-1 items-center flex-grow overflow-y-auto">
    {#if spaces}
      {#each spaces as space}
        <SidebarSpace {space} {me} />
      {/each}
    {/if}
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

    <Login />
  </section>
</aside>
