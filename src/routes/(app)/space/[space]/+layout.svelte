<script lang="ts">
  import Icon from "@iconify/svelte";
  import Dialog from "$lib/components/Dialog.svelte";
  import { Button, ToggleGroup } from "bits-ui";

  import { ulid } from "ulidx";
  import { page } from "$app/state";
  import { g } from "$lib/global.svelte";
  import { goto } from "$app/navigation";
  import { outerWidth } from "svelte/reactivity/window";

  import type { Space } from "$lib/schemas/types";
  import type { Autodoc } from "$lib/autodoc/peer";
  import { user } from "$lib/user.svelte";
  import { setContext } from "svelte";

  let { children } = $props();
  let isMobile = $derived((outerWidth.current || 0) < 640);

  let space = $derived(g.spaces[page.params.space]) as
    | Autodoc<Space>
    | undefined;

  let isAdmin = $derived(
    space && user.agent && space.view.admins.includes(user.agent.assertDid),
  );
  setContext("isAdmin", () => isAdmin);

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
      !isMobile && "max-w-[16rem] border-r-2 border-violet-900",
      "p-4 flex flex-col gap-4 w-full",
    ]}
  >
    <div class="flex items-center justify-between px-2">
      <h1 class="text-2xl font-extrabold text-white text-ellipsis">
        {space.view.name}
      </h1>

      {#if isAdmin}
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

          <Dialog
            title="Create Channel"
            bind:isDialogOpen={showNewChannelDialog}
          >
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
      {/if}
    </div>

    <hr />

    <!-- Category and Channels -->
    {#each space.view.sidebarItems as item}
      {#if item.type == "category"}
        {@const category = space.view.categories[item.id]}
        <h2 class="flex gap-2 items-center justify-start text-white">
          <Icon icon="basil:folder-solid" />
          {category.name}

          <span class="flex-grow"></span>

          {#if isAdmin}
            <Dialog
              title="Channel Settings"
              bind:isDialogOpen={showCategoryDialog}
            >
              {#snippet dialogTrigger()}
                <Button.Root
                  title="Channel Settings"
                  class="cursor-pointer hover:scale-105 active:scale-95 transition-all duration-150 m-auto flex"
                  onclick={() => {
                    editingCategory = item.id;
                    categoryNameInput = category.name;
                  }}
                >
                  <Icon icon="lucide:settings" color="white" class="text-xl" />
                </Button.Root>
              {/snippet}

              <form class="flex flex-col gap-4 w-full" onsubmit={saveCategory}>
                <label>
                  Name
                  <input
                    bind:value={categoryNameInput}
                    placeholder="channel-name"
                    class="w-full outline-hidden border border-white px-4 py-2 rounded-sm bg-transparent"
                  />
                </label>
                <Button.Root
                  class={`px-4 py-2 bg-white text-black rounded-lg disabled:bg-white/50 active:scale-95 transition-all duration-150 flex items-center justify-center gap-2 hover:scale-[102%]`}
                >
                  Save Category
                </Button.Root>
              </form>
            </Dialog>
          {/if}
        </h2>
        <hr />
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
              <h3 class="flex justify-start items-center gap-2 ml-2">
                <Icon icon="basil:comment-solid" />
                {channel.name}
              </h3>
            </ToggleGroup.Item>
          {/each}
        </ToggleGroup.Root>
      {:else}
        {@const channel = space.view.channels[item.id]}
        <ToggleGroup.Root type="single" bind:value={currentChannelId}>
          <ToggleGroup.Item
            onclick={() => goto(`/space/${page.params.space}/${item.id}`)}
            value={item.id}
            class="w-full text-start hover:scale-105 transition-all duration-150 active:scale-95 hover:bg-white/5 border border-transparent data-[state=on]:border-white data-[state=on]:scale-98 data-[state=on]:bg-white/5 text-white py-2 rounded-md"
          >
            <h3 class="flex justify-start items-center gap-2 px-2">
              <Icon icon="basil:comment-solid" />
              {channel.name}
            </h3>
          </ToggleGroup.Item>
        </ToggleGroup.Root>
      {/if}
    {/each}
  </nav>

  <!-- Events/Room Content -->
  {#if !isMobile}
    <main
      class="flex flex-col gap-4 bg-violet-950 rounded-lg p-4 grow min-w-0 h-full overflow-clip"
    >
      {@render children()}
    </main>
  {:else if page.params.channel}
    <main
      class="absolute inset-0 flex flex-col gap-4 bg-violet-950 rounded-lg p-4 h-screen overflow-clip"
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
