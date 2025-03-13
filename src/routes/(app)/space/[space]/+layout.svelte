<script lang="ts">
  import Icon from "@iconify/svelte";
  import Dialog from "$lib/components/Dialog.svelte";
  import { Accordion, Button, ToggleGroup } from "bits-ui";

  import { ulid } from "ulidx";
  import { page } from "$app/state";
  import { g } from "$lib/global.svelte";
  import { goto } from "$app/navigation";
  import { outerWidth } from "svelte/reactivity/window";

  import type { Space } from "$lib/schemas/types";
  import type { Autodoc } from "$lib/autodoc/peer";
  import { user } from "$lib/user.svelte";
  import { setContext } from "svelte";
  import { slide } from "svelte/transition";
  import type { Item } from "$lib/tiptap/editor";
  import { getProfile } from "$lib/profile.svelte";
  import { isAnnouncement } from "$lib/utils";

  let { children } = $props();
  let isMobile = $derived((outerWidth.current || 0) < 640);
  let sidebarAccordionValues = $state(["channels", "threads"]);

  let space = $derived(g.spaces[page.params.space] as Autodoc<Space> | undefined) 

  // TODO: track users via the space data
  let users = $state(() => {
    if (!space) { return [] };
    const result = new Set();
    for (const message of Object.values(space.view.messages)) {
      if (!isAnnouncement(message)) {
        result.add(message.author);
      }
    }
    const items = result.values().toArray().map((author) => { 
      const profile = getProfile(author as string);
      return { value: author, label: profile.handle, category: "user" }
    }) as Item[];

    return items;
  });

  let availableThreads = $derived(
    space ? Object.fromEntries(
      Object.entries(space.view.threads).filter(([ulid, thread]) => 
      !thread.softDeleted
    )) : {}
  );

  let contextItems: Item[] = $derived.by(() => {
    if (!space) { return [] };
    const items = [];

    // add threads to list
    for (const thread of Object.values(space.view.threads)) {
      if (!thread.softDeleted) {
        items.push({ 
          value: JSON.stringify({
            ulid,
            space: page.params.space,
            type: "thread"
          }), 
          label: thread.title,
          category: "thread"
        }) 
      }
    }

    // add channels to list
    items.push(...Object.values(space.view.channels).map((channel) => {
      return {
        value: JSON.stringify({
          ulid,
          space: page.params.space,
          type: "channel"
        }),
        label: channel.name,
        category: "channel"
      }
    }));
  
    return items;
  });
  let isAdmin = $derived( 
    space && user.agent && space.view.admins.includes(user.agent.assertDid)
  );

  setContext("isAdmin", { get value() { return isAdmin }});
  setContext("space", { get value() { return space }});
  setContext("users", { get value() { return users() }});
  setContext("contextItems", { get value() { return contextItems }});

  let showNewCategoryDialog = $state(false);
  let newCategoryName = $state("");
  function createCategory() {
    space?.change((doc) => {
      const id = ulid();
      doc.categories[id] = {
        channels: [],
        name: newCategoryName,
      };
      doc.sidebarItems.push({
        type: "category",
        id,
      });
    });
    showNewCategoryDialog = false;
  }

  let currentItemId = $state("");
  $effect(() => {
    if (page.params.channel) {
      currentItemId = page.params.channel;
    }
    else {
      currentItemId = page.params.thread;
    }
  });
  
  let showNewChannelDialog = $state(false);
  let newChannelName = $state("");
  let newChannelCategory = $state(undefined) as undefined | string;
  function createChannel() {
    const id = ulid();
    space?.change((doc) => {
      doc.channels[id] = {
        name: newChannelName,
        threads: [],
        timeline: [],
        avatar: "",
        description: "",
      };
      if (!newChannelCategory) {
        doc.sidebarItems.push({
          type: "channel",
          id,
        });
      } else {
        doc.categories[newChannelCategory].channels.push(id);
      }
    });

    newChannelCategory = undefined;
    newChannelName = "";
    showNewChannelDialog = false;
  }

  function openSpace() {
    if (space) return;
    g.catalog?.change((doc) => {
      doc.spaces.push({
        id: page.params.space,
        knownMembers: [],
      });
    });
  }

  //
  // Category Edit Dialog
  //

  let showCategoryDialog = $state(false);
  let editingCategory = $state("");
  let categoryNameInput = $state("");
  function saveCategory() {
    space?.change((space) => {
      space.categories[editingCategory].name = categoryNameInput;
    });
    showCategoryDialog = false;
  }
</script>

{#if space}
  <nav
    class={[
      !isMobile && "max-w-[16rem] border-r-2 border-base-200",
      "px-4 py-5 flex flex-col gap-4 w-full",
    ]}
  >
    <h1 class="text-2xl font-extrabold text-neutral-content text-ellipsis">
      {space.view.name}
    </h1>

    <div class="divider my-0"></div>

    {#if isAdmin}
      <menu class="menu p-0 w-full justify-between join join-vertical">
        <Dialog
          title="Create Channel"
          bind:isDialogOpen={showNewChannelDialog}
        >
          {#snippet dialogTrigger()}
            <Button.Root
              title="Create Channel"
              class="btn w-full justify-start join-item text-neutral-content"
            >
              <Icon icon="basil:comment-plus-solid" class="size-6" />
              Create Channel
            </Button.Root>
          {/snippet}

          <form class="flex flex-col gap-4" onsubmit={createChannel}>
            <input
              bind:value={newChannelName}
              placeholder="Name"
              class="w-full outline-hidden border border-white px-4 py-2 rounded-sm bg-transparent"
            />
            <select bind:value={newChannelCategory}>
              <option class="bg-violet-900 text-white" value={undefined}
                >Category: None</option
              >
              {#each Object.keys(space.view.categories) as categoryId}
                {@const category = space.view.categories[categoryId]}
                <option class="bg-violet-900 text-white" value={categoryId}
                  >Category: {category.name}</option
                >
              {/each}
            </select>
            <Button.Root
              class="px-4 py-2 bg-white text-black rounded-lg  active:scale-95 transition-all duration-150 flex items-center justify-center gap-2"
            >
              <Icon icon="basil:add-outline" font-size="1.8em" />
              Create Channel
            </Button.Root>
          </form>
        </Dialog>

        <Dialog
          title="Create Category"
          bind:isDialogOpen={showNewCategoryDialog}
        >
          {#snippet dialogTrigger()}
            <Button.Root
              class="btn w-full justify-start join-item text-neutral-content"
              title="Create Category"
            >
              <Icon icon="basil:folder-plus-solid" class="size-6" />
              Create Category
            </Button.Root>
          {/snippet}

          <form class="flex flex-col gap-4" onsubmit={createCategory}>
            <input
              bind:value={newCategoryName}
              placeholder="Name"
              class="w-full outline-hidden border border-white px-4 py-2 rounded-sm bg-transparent"
            />
            <Button.Root
              class={`px-4 py-2 bg-white text-black rounded-lg active:scale-95 transition-all duration-150 flex items-center justify-center gap-2`}
            >
              <Icon icon="basil:add-outline" font-size="1.8em" />
              Create Category
            </Button.Root>
          </form>
        </Dialog>
      </menu>
    {/if}
  
    <ToggleGroup.Root type="single" bind:value={currentItemId}>
      <Accordion.Root 
        type="multiple" 
        bind:value={sidebarAccordionValues} 
        class="flex flex-col gap-4"
      > 
        <Accordion.Item value="channels">
          <Accordion.Header>
            <Accordion.Trigger class="cursor-pointer flex w-full items-center justify-between mb-2 uppercase text-xs font-medium text-gray-300">
              <h3>Channels</h3>
              <Icon icon="basil:caret-up-solid" class={`size-4 transition-transform duration-150 ${sidebarAccordionValues.includes("channels") && "rotate-180"}`} /> 
            </Accordion.Trigger>
          </Accordion.Header>
          <Accordion.Content forceMount>
            {#snippet child({ open })}
              {#if open}
                {@render channelsSidebar(space as Autodoc<Space>)}
              {/if}
            {/snippet}
          </Accordion.Content>
        </Accordion.Item>
        {#if Object.keys(availableThreads).length > 0}
          <div class="divider my-0"></div>
          <Accordion.Item value="threads">
            <Accordion.Header>
              <Accordion.Trigger class="cursor-pointer flex w-full items-center justify-between mb-2 uppercase text-xs font-medium text-gray-300">
                <h3>Threads</h3>
                <Icon icon="basil:caret-up-solid" class={`size-4 transition-transform duration-150 ${sidebarAccordionValues.includes("threads") && "rotate-180"}`} /> 
              </Accordion.Trigger>
            </Accordion.Header>
            <Accordion.Content>
              {#snippet child({ open })}
                {#if open}
                  {@render threadsSidebar()}
                {/if}
              {/snippet}
            </Accordion.Content>
          </Accordion.Item>
        {/if}
      </Accordion.Root>
    </ToggleGroup.Root>
  </nav>

  <!-- Events/Room Content -->
  {#if !isMobile}
    <main
      class="flex flex-col gap-4 rounded-lg p-4 grow min-w-0 h-full overflow-clip"
    >
      {@render children()}
    </main>
  {:else if page.params.channel}
    <main
      class="absolute inset-0 flex flex-col gap-4 rounded-lg p-4 h-screen overflow-clip"
    >
      {@render children()}
    </main>
  {/if}

  <!-- If there is no space. -->
{:else}
  <div class="flex flex-col justify-center items-center w-full">
    <Button.Root
      onclick={openSpace}
      class="px-4 py-2 bg-white text-black rounded-lg  active:scale-95 transition-all duration-150 flex items-center justify-center gap-2 cursor-pointer"
    >
      Join Space
    </Button.Root>
  </div>
{/if}

{#snippet channelsSidebar(space: Autodoc<Space>)}
  <div transition:slide class="flex flex-col gap-4">
    <!-- Category and Channels -->
    {#each space.view.sidebarItems as item}
      {#if item.type == "category"}
        {@const category = space.view.categories[item.id]}
        <Accordion.Root type="single" value={category.name}> 
          <Accordion.Item value={category.name}> 
            <Accordion.Header class="flex justify-between"> 
              <Accordion.Trigger class="flex text-sm font-semibold gap-2 items-center cursor-pointer">
                <Icon icon="basil:folder-solid" />
                {category.name}
              </Accordion.Trigger>

              {#if isAdmin}
                <Dialog
                  title="Channel Settings"
                  bind:isDialogOpen={showCategoryDialog}
                >
                  {#snippet dialogTrigger()}
                    <Button.Root
                      title="Channel Settings"
                      class="cursor-pointer btn btn-ghost btn-circle"
                      onclick={() => {
                        editingCategory = item.id;
                        categoryNameInput = category.name;
                      }}
                    >
                      <Icon icon="lucide:settings" class="size-4" />
                    </Button.Root>
                  {/snippet}

                  <form class="flex flex-col gap-4 w-full" onsubmit={saveCategory}>
                    <label class="input w-full">
                      <span class="label">Name</span>
                      <input
                        bind:value={categoryNameInput}
                        placeholder="channel-name"
                      />
                    </label>
                    <Button.Root disabled={!categoryNameInput} class="btn btn-primary">
                      Save Category
                    </Button.Root>
                  </form>
                </Dialog>
              {/if}
            </Accordion.Header>

            <Accordion.Content forceMount>
              {#snippet child({ props, open })}
                {#if open}
                  <div {...props} transition:slide class="flex flex-col gap-4 py-2">
                    {#each category.channels as channelId}
                      {@const channel = space.view.channels[channelId]}
                      <ToggleGroup.Item
                        onclick={() => goto(`/space/${page.params.space}/${channelId}`)}
                        value={item.id}
                        class="w-full cursor-pointer px-1 btn btn-ghost justify-start border border-transparent data-[state=on]:border-accent data-[state=on]:text-accent"
                      >
                        <h3 class="flex justify-start items-center gap-2 px-2">
                          <Icon icon="basil:comment-solid" />
                          {channel.name}
                        </h3>
                      </ToggleGroup.Item>
                    {/each}
                  </div>
                {/if}
              {/snippet}
            </Accordion.Content>
          </Accordion.Item>
        </Accordion.Root>
      {:else}
        {@const channel = space.view.channels[item.id]}
        <ToggleGroup.Item
          onclick={() => goto(`/space/${page.params.space}/${item.id}`)}
          value={item.id}
          class="w-full cursor-pointer px-1 btn btn-ghost justify-start border border-transparent data-[state=on]:border-accent data-[state=on]:text-accent"
        >
          <h3 class="flex justify-start items-center gap-2 px-2">
            <Icon icon="basil:comment-solid" />
            {channel.name}
          </h3>
        </ToggleGroup.Item>
      {/if}
    {/each}
  </div>
{/snippet}

{#snippet threadsSidebar()}
  <div transition:slide class="flex flex-col gap-4">
    {#each Object.entries(availableThreads) as [ulid, thread]} 
        <ToggleGroup.Item
          onclick={() => goto(`/space/${page.params.space}/thread/${ulid}`)}
          value={ulid}
          class="w-full cursor-pointer px-1 btn btn-ghost justify-start border border-transparent data-[state=on]:border-accent data-[state=on]:text-accent"
        >
          <h3 class="flex justify-start items-center gap-2 px-2">
            <Icon icon="material-symbols:thread-unread-rounded" />
            {thread.title}
          </h3>
        </ToggleGroup.Item>
    {/each}
  </div>
{/snippet}