<script lang="ts">
  import Icon from "@iconify/svelte";
  import Dialog from "$lib/components/Dialog.svelte";
  import { Accordion, Button, ToggleGroup } from "bits-ui";
  import { page } from "$app/state";
  import { g } from "$lib/global.svelte";
  import { slide } from "svelte/transition";
  import { derivePromise, navigate } from "$lib/utils.svelte";
  import { Category, Channel } from "@roomy-chat/sdk";
  import { outerWidth } from "svelte/reactivity/window";

  let isMobile = $derived((outerWidth.current || 0) < 640);

  let sidebarAccordionValues = $state(["channels", "threads"]);

  let availableThreads = derivePromise([], async () => {
    const active = g.channel;
    if (!active || !active.matches(Channel)) return [];
    return ((await active.threads?.items()) || []).filter(
      (x) => !x.softDeleted,
    );
  });

  let { categories, channels } = $props();

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

  //
  // Category Edit Dialog
  //

  let showCategoryDialog = $state(false);
  let editingCategory = $state(undefined) as undefined | Category;
  let categoryNameInput = $state("");
  function saveCategory() {
    if (!editingCategory) return;
    editingCategory.name = categoryNameInput;
    editingCategory.commit();
    showCategoryDialog = false;
  }
</script>

<nav
  class="min-h-0 overflow-y-auto px-2 flex flex-col gap-4 w-full"
  style="scrollbar-width: thin;"
>
  {#if g.isAdmin}
    <menu class="menu p-0 w-full justify-between join join-vertical">
      <Dialog title="Create Channel" bind:isDialogOpen={showNewChannelDialog}>
        {#snippet dialogTrigger()}
          <Button.Root
            title="Create Channel"
            class="btn w-full justify-start join-item text-base-content"
          >
            <Icon icon="basil:comment-plus-solid" class="size-6" />
            Create Channel
          </Button.Root>
        {/snippet}

        <form class="flex flex-col gap-4" onsubmit={createChannel}>
          <label class="input w-full">
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
          <Button.Root class="btn btn-primary">
            <Icon icon="basil:add-outline" font-size="1.8em" />
            Create Channel
          </Button.Root>
        </form>
      </Dialog>

      <Dialog title="Create Category" bind:isDialogOpen={showNewCategoryDialog}>
        {#snippet dialogTrigger()}
          <Button.Root
            class="btn w-full justify-start join-item text-base-content"
            title="Create Category"
          >
            <Icon icon="basil:folder-plus-solid" class="size-6" />
            Create Category
          </Button.Root>
        {/snippet}

        <form class="flex flex-col gap-4" onsubmit={createCategory}>
          <label class="input w-full">
            <span class="label">Name</span>
            <input bind:value={newCategoryName} placeholder="Discussions" />
          </label>
          <Button.Root class="btn btn-primary">
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
              {@render channelsSidebar()}
            {/if}
          {/snippet}
        </Accordion.Content>
      </Accordion.Item>
    </Accordion.Root>
  </ToggleGroup.Root>
</nav>

<!-- Events/Room Content -->

<!-- If there is no space. -->

{#snippet channelsSidebar()}
  <div transition:slide class="flex flex-col gap-4">
    <!-- Category and Channels -->
    {#each channels.value as item}
      {@const category = item.tryCast(Category)}
      <!-- TODO: ToggleGroup's by category -->
      {#if category}
        <Accordion.Root type="single" value={item.name}>
          <Accordion.Item value={item.name}>
            <Accordion.Header class="flex justify-between">
              <Accordion.Trigger
                class="flex text-sm font-semibold gap-2 items-center cursor-pointer"
              >
                <Icon icon="basil:folder-solid" />
                {item.name}
              </Accordion.Trigger>

              {#if g.isAdmin}
                <Dialog
                  title="Channel Settings"
                  bind:isDialogOpen={showCategoryDialog}
                >
                  {#snippet dialogTrigger()}
                    <Button.Root
                      title="Channel Settings"
                      class="cursor-pointer btn btn-ghost btn-circle"
                      onclick={() => {
                        editingCategory = category;
                        categoryNameInput = item.name;
                      }}
                    >
                      <Icon icon="lucide:settings" class="size-4" />
                    </Button.Root>
                  {/snippet}

                  <form
                    class="flex flex-col gap-4 w-full"
                    onsubmit={saveCategory}
                  >
                    <label class="input w-full">
                      <span class="label">Name</span>
                      <input
                        bind:value={categoryNameInput}
                        placeholder="channel-name"
                      />
                    </label>
                    <Button.Root
                      disabled={!categoryNameInput}
                      class="btn btn-primary"
                    >
                      Save Category
                    </Button.Root>
                  </form>
                </Dialog>
              {/if}
            </Accordion.Header>

            <Accordion.Content forceMount>
              {#snippet child({
                props,
                open,
              }: {
                open: boolean;
                props: unknown[];
              })}
                {#if open}
                  <div
                    {...props}
                    transition:slide
                    class="flex flex-col gap-4 py-2"
                  >
                    {#each category.channels.ids() as channelId}
                      {#await g.roomy && g.roomy.open(Channel, channelId) then channel}
                        {#if !channel?.softDeleted}
                          <ToggleGroup.Item
                            onclick={() =>
                              navigate({
                                space: page.params.space!,
                                channel: channelId,
                              })}
                            value={channelId}
                            class="w-full cursor-pointer px-1 btn btn-ghost justify-start border border-transparent data-[state=on]:border-primary data-[state=on]:text-primary"
                          >
                            <h3
                              class="flex justify-start items-center gap-2 px-2"
                            >
                              <Icon icon="basil:comment-solid" />
                              {channel?.name || "..."}
                            </h3>
                          </ToggleGroup.Item>
                        {/if}
                      {/await}
                    {/each}
                  </div>
                {/if}
              {/snippet}
            </Accordion.Content>
          </Accordion.Item>
        </Accordion.Root>
      {:else if item.matches(Channel)}
        <ToggleGroup.Item
          onclick={() =>
            navigate({
              space: page.params.space!,
              channel: item.id,
            })}
          value={item.id}
          class="w-full cursor-pointer px-1 btn btn-ghost justify-start border border-transparent data-[state=on]:border-primary data-[state=on]:text-primary"
        >
          <h3 class="flex justify-start items-center gap-2 px-2">
            <Icon icon="basil:comment-solid" />
            {item.name}
          </h3>
        </ToggleGroup.Item>
      {/if}
      {#if item.id === page.params.channel}
        <div class="opacity-80 pl-2 -mt-4">
          {@render threadsSidebar(4)}
        </div>
      {/if}
    {/each}
  </div>
{/snippet}

{#snippet threadsSidebar(limit = Infinity)}
  <div class="flex flex-col gap-1">
    {#each availableThreads.value.filter((_, i) => i < limit) as thread}
      <ToggleGroup.Item
        onclick={() =>
          navigate({ space: page.params.space!, thread: thread.id })}
        value={thread.id}
        class="w-full cursor-pointer px-1 btn btn-ghost justify-start border border-transparent data-[state=on]:border-primary data-[state=on]:text-primary"
      >
        <h3 class="flex justify-start items-center gap-2 px-2">
          <Icon icon="material-symbols:thread-unread-rounded" />
          {thread.name}
        </h3>
      </ToggleGroup.Item>
    {/each}
  </div>
{/snippet}
