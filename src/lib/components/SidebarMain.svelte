<script lang="ts">
  import Icon from "@iconify/svelte";
  import Dialog from "$lib/components/Dialog.svelte";
  import { Button } from "bits-ui";

  import { g } from "$lib/global.svelte";
  import { outerWidth } from "svelte/reactivity/window";

  import { derivePromise, Toggle } from "$lib/utils.svelte";
  import { Category, Channel } from "@roomy-chat/sdk";
  import SpaceSettingsDialog from "$lib/components/SpaceSettingsDialog.svelte";
  import SidebarChat from "./SidebarChat.svelte";
  import ToggleSidebarIcon from "./ToggleSidebarIcon.svelte";
  import { getContext } from "svelte";

  let isMobile = $derived((outerWidth.current || 0) < 640);

  let availableThreads = derivePromise([], async () =>
    ((await g.space?.threads.items()) || []).filter((x) => !x.softDeleted),
  );

  let categories = derivePromise([], async () => {
    if (!g.space) return [];
    return (await g.space.sidebarItems.items())
      .map((x) => x.tryCast(Category) as Category)
      .filter((x) => !!x);
  });

  let sidebarItems = derivePromise([], async () => {
    if (!g.space) return [];
    return await g.space.sidebarItems.items();
  });

  let showNewCategoryDialog = $state(false);
  let newCategoryName = $state("");
  async function createCategory() {
    if (!g.roomy || !g.space) return;

    const category = await g.roomy.create(Category);
    category.name = newCategoryName;
    category.appendAdminsFrom(g.space);
    category.commit();
    g.space.sidebarItems.push(category);
    g.space.commit();

    showNewCategoryDialog = false;
  }

  let showNewChannelDialog = $state(false);
  let newChannelName = $state("");
  let newChannelCategory = $state(undefined) as undefined | Category;
  async function createChannel() {
    if (!g.roomy || !g.space) return;
    const channel = await g.roomy.create(Channel);
    channel.appendAdminsFrom(g.space);
    channel.name = newChannelName;
    channel.commit();

    g.space.channels.push(channel);
    if (newChannelCategory) {
      newChannelCategory.channels.push(channel);
      newChannelCategory.commit();
    } else {
      g.space.sidebarItems.push(channel);
    }
    g.space.commit();

    newChannelCategory = undefined;
    newChannelName = "";
    showNewChannelDialog = false;
  }
  let isSpacesVisible: ReturnType<typeof Toggle> =
    getContext("isSpacesVisible");
</script>

<nav
  class="w-[min(70vw,20rem)] sm:w-[16rem] bg-base-300 flex h-full flex-col gap-1 border-r-2 border-base-300"
  style="scrollbar-width: thin;"
>
  <!-- Header -->
  <div
    class="w-full py-1 px-2 h-fit grid grid-cols-[auto_1fr_auto] justify-center items-center"
  >
    <ToggleSidebarIcon class="mr-2 px-1 py-1" open={isSpacesVisible} />
    <h1 class="text-sm font-bold text-base-content truncate">
      {g.space?.name && g.space?.name !== "Unnamed" ? g.space.name : ""}
    </h1>

    {#if g.isAdmin}
      <SpaceSettingsDialog />
    {/if}
  </div>

  <div class="divider my-0"></div>

  {#if g.isAdmin}
    <menu class="dz-menu p-0 w-full justify-between dz-join dz-join-vertical">
      <Dialog title="Create Channel" bind:isDialogOpen={showNewChannelDialog}>
        {#snippet dialogTrigger()}
          <Button.Root
            title="Create Channel"
            class="dz-btn w-full justify-start dz-join-item text-base-content"
          >
            <Icon icon="basil:comment-plus-solid" class="size-6" />
            Create Channel
          </Button.Root>
        {/snippet}

        <form class="flex flex-col gap-4" onsubmit={createChannel}>
          <label class="dz-input w-full">
            <span class="label">Name</span>
            <input bind:value={newChannelName} placeholder="General" />
          </label>
          <label class="select w-full">
            <span class="label">Category</span>
            <select bind:value={newChannelCategory}>
              <option value={undefined}>None</option>
              {#each categories.value as category}
                <option value={category}>{category.name}</option>
              {/each}
            </select>
          </label>
          <Button.Root class="dz-btn dz-btn-primary">
            <Icon icon="basil:add-outline" font-size="1.8em" />
            Create Channel
          </Button.Root>
        </form>
      </Dialog>

      <Dialog title="Create Category" bind:isDialogOpen={showNewCategoryDialog}>
        {#snippet dialogTrigger()}
          <Button.Root
            class="dz-btn w-full justify-start dz-join-item text-base-content"
            title="Create Category"
          >
            <Icon icon="basil:folder-plus-solid" class="size-6" />
            Create Category
          </Button.Root>
        {/snippet}

        <form class="flex flex-col gap-4" onsubmit={createCategory}>
          <label class="dz-input w-full">
            <span class="label">Name</span>
            <input bind:value={newCategoryName} placeholder="Discussions" />
          </label>
          <Button.Root class="dz-btn dz-btn-primary">
            <Icon icon="basil:add-outline" font-size="1.8em" />
            Create Category
          </Button.Root>
        </form>
      </Dialog>
    </menu>
  {/if}

  <SidebarChat {availableThreads} {sidebarItems} />
</nav>
