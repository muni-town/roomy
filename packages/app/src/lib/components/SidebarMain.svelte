<script lang="ts">
  import Icon from "@iconify/svelte";
  import Dialog from "$lib/components/Dialog.svelte";
  import { Button, Tabs } from "bits-ui";

  import { globalState } from "$lib/global.svelte";

  import { derivePromise, navigate, Toggle } from "$lib/utils.svelte";
  import { Category, Channel, Thread } from "@roomy-chat/sdk";
  import SpaceSettingsDialog from "$lib/components/SpaceSettingsDialog.svelte";
  import ToggleSidebarIcon from "./ToggleSidebarIcon.svelte";
  import { getContext } from "svelte";
  import AccordionTree from "./AccordionTree.svelte";
  import SidebarChannelList from "./SidebarChannelList.svelte";
  import { focusOnRender } from "$lib/actions/useFocusOnRender.svelte";
  import { page } from "$app/state";

  export async function createLinkFeed() {
    if (!globalState.roomy || !globalState.space) return;

    try {
      const thread = await globalState.roomy.create(Thread);
      thread.name = "@links";
      thread.commit();
      globalState.space.threads.push(thread);
      globalState.space.commit();

      navigate({ space: page.params.space!, thread: thread.id });
    } catch (e) {
      console.error(e);
    }
  }

  let allThreads = derivePromise([], async () =>
    ((await globalState.space?.threads.items()) || [])
      .filter((x) => !x.softDeleted)
      .map((x) => ({
        target: {
          space: page.params.space!,
          thread: x.id,
        },
        name: x.name,
        id: x.id,
      })),
  );
  let topics = $derived(allThreads.value.filter((x) => x.name !== "@links"));
  let links = $derived(allThreads.value.find((x) => x.name === "@links"));

  const pages = derivePromise([], async () =>
    ((await globalState.space?.wikipages.items()) || [])
      .filter((x) => !x.softDeleted)
      .map((x) => ({
        target: {
          space: page.params.space!,
          page: x.id,
        },
        name: x.name,
        id: x.id,
      })),
  );

  let categories = derivePromise([], async () => {
    if (!globalState.space) return [];
    return (await globalState.space.sidebarItems.items())
      .map((x) => x.tryCast(Category) as Category)
      .filter((x) => !!x);
  });

  let sidebarItems = derivePromise([], async () => {
    if (!globalState.space) return [];
    return await globalState.space.sidebarItems.items();
  });
  let showNewCategoryDialog = $state(false);
  let newCategoryName = $state("");
  async function createCategory() {
    if (!globalState.roomy || !globalState.space) return;

    const category = await globalState.roomy.create(Category);
    category.name = newCategoryName;
    category.appendAdminsFrom(globalState.space);
    category.commit();
    globalState.space.sidebarItems.push(category);
    globalState.space.commit();

    showNewCategoryDialog = false;
  }

  let showNewChannelDialog = $state(false);
  let newChannelName = $state("");
  let newChannelCategory = $state(undefined) as undefined | Category;
  async function createChannel() {
    if (!globalState.roomy || !globalState.space) return;
    const channel = await globalState.roomy.create(Channel);
    channel.appendAdminsFrom(globalState.space);
    channel.name = newChannelName;
    channel.commit();

    globalState.space.channels.push(channel);
    if (newChannelCategory) {
      newChannelCategory.channels.push(channel);
      newChannelCategory.commit();
    } else {
      globalState.space.sidebarItems.push(channel);
    }
    globalState.space.commit();

    newChannelCategory = undefined;
    newChannelName = "";
    showNewChannelDialog = false;
  }
  let isSpacesVisible: ReturnType<typeof Toggle> =
    getContext("isSpacesVisible");
  let tab: "board" | "chat" = $state("chat");
</script>

<nav
  class="w-[min(70vw,16rem)] bg-base-300 flex h-full flex-col gap-1 border-r-2 border-base-300"
  style="scrollbar-width: thin;"
>
  <!-- Header -->
  <div
    class="w-full pt-4 pb-1 px-2 h-fit grid grid-cols-[auto_1fr_auto] justify-center items-center"
  >
    <ToggleSidebarIcon class="pr-2" open={isSpacesVisible} />
    <h1 class="text-sm font-bold text-base-content truncate">
      {globalState.space?.name && globalState.space?.name !== "Unnamed"
        ? globalState.space.name
        : ""}
    </h1>

    {#if globalState.isAdmin}
      <SpaceSettingsDialog />
    {/if}
  </div>

  {#if globalState.isAdmin}
    <menu
      class="dz-menu p-0 w-full justify-between px-2 dz-join dz-join-vertical"
    >
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

        <form
          id="createChannel"
          class="flex flex-col gap-4"
          onsubmit={createChannel}
        >
          <label class="dz-input w-full">
            <span class="dz-label">Name</span>
            <input
              bind:value={newChannelName}
              use:focusOnRender
              placeholder="General"
              type="text"
              required
            />
          </label>
          <label class="dz-select w-full">
            <span class="dz-label">Category</span>
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

        <form
          id="createCategory"
          class="flex flex-col gap-4"
          onsubmit={createCategory}
        >
          <label class="dz-input w-full">
            <span class="dz-label">Name</span>
            <input
              bind:value={newCategoryName}
              use:focusOnRender
              placeholder="Discussions"
              type="text"
              required
            />
          </label>
          <Button.Root class="dz-btn dz-btn-primary">
            <Icon icon="basil:add-outline" font-size="1.8em" />
            Create Category
          </Button.Root>
        </form>
      </Dialog>
    </menu>
  {/if}

  <!-- Index Chat Toggle -->
  <Tabs.Root bind:value={tab} class="py-1 px-2">
    <Tabs.List class="flex w-full rounded-lg dz-tabs-box">
      <Tabs.Trigger value="board" class="grow dz-tab flex gap-2">
        <Icon
          icon="tabler:clipboard-text{tab === 'board' ? '-filled' : ''}"
          class="text-2xl"
        />
      </Tabs.Trigger>
      <Tabs.Trigger
        disabled={!globalState.roomy}
        value="chat"
        class="grow dz-tab flex gap-2"
      >
        <Icon
          icon="tabler:message{tab === 'chat' ? '-filled' : ''}"
          class="text-2xl"
        />
      </Tabs.Trigger>
    </Tabs.List>
  </Tabs.Root>
  <div class="py-2 w-full max-h-full overflow-y-auto overflow-x-clip mx-1">
    {#if tab === "board"}
      {#if links}
        <div class="flex-flex-col gap-4 p-2">
          <Button.Root
            class="cursor-pointer px-2 flex w-full items-center justify-between mb-2 uppercase text-xs font-medium text-base-content"
            onclick={() => {
              navigate({ space: page.params.space!, thread: links.id });
            }}
          >
            Links
          </Button.Root>
          <div class="dz-divider my-0"></div>
        </div>
      {:else}
        <div class="flex-flex-col gap-4 p-2">
          <Button.Root
            class="cursor-pointer px-2 flex w-full items-center justify-between mb-2 uppercase text-xs font-medium text-base-content"
            onclick={createLinkFeed}
          >
            Create Links Feed
          </Button.Root>
          <div class="dz-divider my-0"></div>
        </div>
      {/if}
      <AccordionTree
        sections={[
          { key: "pages", items: pages.value },
          { key: "topics", items: topics },
        ]}
        active={globalState.channel?.id ?? ""}
      />
    {:else}
      <SidebarChannelList {sidebarItems} />
    {/if}
  </div>
</nav>
