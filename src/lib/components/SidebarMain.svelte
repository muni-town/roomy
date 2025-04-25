<script lang="ts">
  import Icon from "@iconify/svelte";
  import Dialog from "$lib/components/Dialog.svelte";
  import { Accordion, Button, ToggleGroup } from "bits-ui";

  import { g } from "$lib/global.svelte";
  import { outerWidth } from "svelte/reactivity/window";

  import { derivePromise } from "$lib/utils.svelte";
  import { Category, Channel } from "@roomy-chat/sdk";
  import SidebarChannelsList from "$lib/components/SidebarChannelList.svelte";
  import SidebarThreadsList from "$lib/components/SidebarThreadList.svelte";
  import SpaceSettingsDialog from "$lib/components/SpaceSettingsDialog.svelte";

  let isMobile = $derived((outerWidth.current || 0) < 640);
  let sidebarAccordionValues = $state(["channels", "threads"]);

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
</script>

<nav
  class={[
    !isMobile &&
      "max-w-[16rem] border-r-2 border-base-200 max-h-full h-full min-h-0 overflow-y-auto",
    "px-4 py-5 flex flex-col gap-4 w-full",
  ]}
  style="scrollbar-width: thin;"
>
  <div class="flex justify-between">
    <h1 class="text-2xl font-extrabold text-base-content text-ellipsis flex">
      {g.space!.name}
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

  <ToggleGroup.Root type="single" value={g.channel?.id}>
    <Accordion.Root
      type="multiple"
      bind:value={sidebarAccordionValues}
      class="flex flex-col gap-4"
    >
      <Accordion.Item value="channels">
        <Accordion.Header>
          <Accordion.Trigger
            class="cursor-pointer flex w-full items-center justify-between mb-2 uppercase text-xs font-medium text-base-content"
          >
            <h3>Channels</h3>
            <Icon
              icon="basil:caret-up-solid"
              class={`size-4 transition-transform duration-150 ${sidebarAccordionValues.includes("channels") && "rotate-180"}`}
            />
          </Accordion.Trigger>
        </Accordion.Header>
        <Accordion.Content forceMount>
          {#snippet child({ open }: { open: boolean })}
            {#if open}
              <SidebarChannelsList {sidebarItems} />
            {/if}
          {/snippet}
        </Accordion.Content>
      </Accordion.Item>
      {#if availableThreads.value.length > 0}
        <div class="divider my-0"></div>
        <Accordion.Item value="threads">
          <Accordion.Header>
            <Accordion.Trigger
              class="cursor-pointer flex w-full items-center justify-between mb-2 uppercase text-xs font-medium text-base-content"
            >
              <h3>Threads</h3>
              <Icon
                icon="basil:caret-up-solid"
                class={`size-4 transition-transform duration-150 ${sidebarAccordionValues.includes("threads") && "rotate-180"}`}
              />
            </Accordion.Trigger>
          </Accordion.Header>
          <Accordion.Content>
            {#snippet child({ open }: { open: boolean })}
              {#if open}
                <SidebarThreadsList {availableThreads} />
              {/if}
            {/snippet}
          </Accordion.Content>
        </Accordion.Item>
      {/if}
    </Accordion.Root>
  </ToggleGroup.Root>
</nav>
