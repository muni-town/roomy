<script lang="ts">
  import Icon from "@iconify/svelte";
  import Dialog from "$lib/components/Dialog.svelte";
  import { Accordion, Button, Separator, ToggleGroup } from "bits-ui";

  import { ulid } from "ulidx";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { g } from "$lib/global.svelte";
  import { fade, slide } from "svelte/transition";
  import { outerWidth } from "svelte/reactivity/window";
  import type { Autodoc } from "$lib/autodoc/peer";
  import type { Space } from "$lib/schemas/types";

  let { children } = $props();
  let isMobile = $derived((outerWidth.current || 0) < 640);

  let space = $derived(g.spaces[page.params.space]) as
    | Autodoc<Space>
    | undefined;

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

  let currentChannelId = $state("");
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
</script>

{#if space}
  <nav class={`flex flex-col ${isMobile ? "w-full px-2 py-4 gap-4" : "w-72 gap-4 p-4"} h-full bg-violet-950 rounded-lg`}>
    <div class="flex items-center justify-between px-2">
      <h1 class="text-2xl font-extrabold text-white text-ellipsis">
        {space.view.name}
      </h1>

      <menu class="flex gap-2">
        <Dialog 
          title="Create Category"
          bind:isDialogOpen={showNewCategoryDialog}
        >
          {#snippet dialogTrigger()}
            <Button.Root
              class="hover:scale-105 active:scale-95 transition-all duration-150"
              title="Create Category"
            >
              <Icon
                icon="basil:folder-plus-solid"
                color="white"
                font-size="2em"
              />
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

        <Dialog title="Create Channel" bind:isDialogOpen={showNewChannelDialog}>
          {#snippet dialogTrigger()}
            <Button.Root
              class="hover:scale-105 active:scale-95 transition-all duration-150"
              title="Create Channel"
            >
              <Icon
                icon="basil:comment-plus-solid"
                color="white"
                font-size="2em"
              />
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
              class={`px-4 py-2 bg-white text-black rounded-lg  active:scale-95 transition-all duration-150 flex items-center justify-center gap-2`}
            >
              <Icon icon="basil:add-outline" font-size="1.8em" />
              Create Channel
            </Button.Root>
          </form>
        </Dialog>
      </menu>
    </div>

    <hr />

    <!-- Category and Channels -->
    <Accordion.Root multiple class="flex flex-col gap-2 w-full text-white">
      {#each space.view.sidebarItems as item}
        {#if item.type == "category"}
          {@const category = space.view.categories[item.id]}
          <Accordion.Item value={item.id}>
            <Accordion.Header>
              <Accordion.Trigger
                class="w-full flex justify-between items-center px-2 py-4 rounded-lg hover:scale-105 transition-all duration-150 active:scale-95 hover:bg-white/5"
              >
                <h2 class="flex gap-2 items-center justify-start">
                  <Icon icon="basil:folder-solid" />
                  {category.name}
                </h2>
                <Icon icon="ph:caret-up-down-bold" />
              </Accordion.Trigger>
            </Accordion.Header>
            <Accordion.Content transition={slide}>
              <hr class="mb-4" />
              <ToggleGroup.Root
                type="single"
                bind:value={currentChannelId}
                class="flex flex-col gap-2 items-center"
              >
                {#each category.channels as channelId}
                  {@const channel = space.view.channels[channelId]}
                  <ToggleGroup.Item
                    onclick={() => goto(`/space/${page.params.space}/${channelId}`)}
                    value={channelId}
                    class="w-full text-start hover:scale-105 transition-all duration-150 active:scale-95 hover:bg-white/5 border border-transparent data-[state=on]:border-white data-[state=on]:scale-98 data-[state=on]:bg-white/5 text-white px-4 py-2 rounded-md"
                  >
                    <h3 class="flex justify-start items-center gap-2">
                      <Icon icon="basil:comment-solid" />
                      {channel.name}
                    </h3>
                  </ToggleGroup.Item>
                {/each}
              </ToggleGroup.Root>
            </Accordion.Content>
          </Accordion.Item>
        {:else}
          {@const channel = space.view.channels[item.id]}
          <ToggleGroup.Root
            type="single"
            bind:value={currentChannelId}
          >
            <ToggleGroup.Item
              onclick={() => goto(`/space/${page.params.space}/${item.id}`)}
              value={item.id}
              class="w-full text-start hover:scale-105 transition-all duration-150 active:scale-95 hover:bg-white/5 border border-transparent data-[state=on]:border-white data-[state=on]:scale-98 data-[state=on]:bg-white/5 text-white px-4 py-2 rounded-md"
            >
              <h3 class="flex justify-start items-center gap-2">
                <Icon icon="basil:comment-solid" />
                {channel.name}
              </h3>
            </ToggleGroup.Item>
          </ToggleGroup.Root>
        {/if}
      {/each}
    </Accordion.Root>
  </nav>

  <!-- Events/Room Content -->
  {#if !isMobile}
    <main class="flex flex-col gap-4 bg-violet-950 rounded-lg p-4 grow">
      {@render children()}
    </main>
  {:else if page.params.channel}
    <main class="absolute inset-0 flex flex-col gap-4 bg-violet-950 rounded-lg p-4">
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