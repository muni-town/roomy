<script lang="ts">
  import Icon from "@iconify/svelte";
  import { Accordion, Button, Dialog, Separator, ToggleGroup } from "bits-ui";

  import { fade, slide } from "svelte/transition";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { g } from "$lib/global.svelte";
  import { ulid } from "ulidx";

  let { children } = $props();

  let space = $derived(g.spaces[page.params.space]);

  let showNewCategoryDialog = $state(false);
  let newCategoryName = $state("");
  function createCategory() {
    space.change((doc) => {
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

  let showNewChannelDialog = $state(false);
  let newChannelName = $state("");
  let newChannelCategory = $state(undefined) as undefined | string;
  function createChannel() {
    const id = ulid();
    space.change((doc) => {
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
</script>

{#if space}
  <!-- Room Selector; TODO: Sub Menu (eg Settings) -->
  <nav class="flex flex-col gap-4 p-4 h-full w-72 bg-violet-950 rounded-lg">
    <div class="flex items-center justify-between">
      <h1 class="text-2xl font-extrabold text-white px-2 text-ellipsis">
        {space.view.name}
      </h1>
      <div class="mx-3 pt-2">
        <Dialog.Root bind:open={showNewCategoryDialog}>
          <Dialog.Trigger>
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
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay
              transition={fade}
              transitionConfig={{ duration: 150 }}
              class="fixed inset-0 z-50 bg-black/80"
            />

            <Dialog.Content
              class="fixed p-5 flex flex-col text-white gap-4 w-dvw max-w-(--breakpoint-sm) left-[50%] top-[50%] z-50 translate-x-[-50%] translate-y-[-50%] rounded-lg border bg-purple-950"
            >
              <Dialog.Title
                class="text-bold font-bold text-xl flex items-center justify-center gap-4"
              >
                Create Category
              </Dialog.Title>
              <Separator.Root class="border border-white" />
              <form class="flex flex-col gap-4" onsubmit={createCategory}>
                <input
                  bind:value={newCategoryName}
                  placeholder="Name"
                  class="w-full outline-hidden border border-white px-4 py-2 rounded-sm bg-transparent"
                />
                <Button.Root
                  class={`px-4 py-2 bg-white text-black rounded-lg  active:scale-95 transition-all duration-150 flex items-center justify-center gap-2`}
                >
                  <Icon icon="basil:add-outline" font-size="1.8em" />
                  Create Category
                </Button.Root>
              </form>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>

        <Dialog.Root bind:open={showNewChannelDialog}>
          <Dialog.Trigger>
            <Button.Root
              class="hover:scale-105 active:scale-95 transition-all duration-150"
              title="Create Category"
            >
              <Icon
                icon="basil:comment-plus-solid"
                color="white"
                font-size="2em"
              />
            </Button.Root>
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay
              transition={fade}
              transitionConfig={{ duration: 150 }}
              class="fixed inset-0 z-50 bg-black/80"
            />

            <Dialog.Content
              class="fixed p-5 flex flex-col text-white gap-4 w-dvw max-w-(--breakpoint-sm) left-[50%] top-[50%] z-50 translate-x-[-50%] translate-y-[-50%] rounded-lg border bg-purple-950"
            >
              <Dialog.Title
                class="text-bold font-bold text-xl flex items-center justify-center gap-4"
              >
                Create Channel
              </Dialog.Title>
              <Separator.Root class="border border-white" />
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
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </div>
    </div>
    <hr />

    <!-- Category and Channels -->
    <Accordion.Root multiple class="flex flex-col gap-4 w-full text-white">
      {#each space.view.sidebarItems as item}
        {#if item.type == "category"}
          {@const category = space.view.categories[item.id]}
          <Accordion.Item value={item.id}>
            <Accordion.Header>
              <Accordion.Trigger
                class="w-full flex justify-between items-center px-2 py-4 rounded-lg hover:scale-105 transition-all duration-150 active:scale-95 hover:bg-white/5"
              >
                <h2>{category.name}</h2>
                <Icon icon="ph:caret-up-down-bold" />
              </Accordion.Trigger>
            </Accordion.Header>
            <Accordion.Content transition={slide}>
              <hr class="mb-4" />
              <ToggleGroup.Root
                type="single"
                class="flex flex-col gap-4 items-center"
              >
                {#each category.channels as channelId}
                  {@const channel = space.view.channels[channelId]}
                  <ToggleGroup.Item
                    onclick={() =>
                      goto(`/space/${page.params.space}/${channelId}`)}
                    value={channelId}
                    class="w-full text-start hover:scale-105 transition-all duration-150 active:scale-95 hover:bg-white/5 border border-transparent data-[state=on]:border-white data-[state=on]:scale-98 data-[state=on]:bg-white/5 text-white px-4 py-2 rounded-md"
                  >
                    <h3># {channel.name}</h3>
                  </ToggleGroup.Item>
                {/each}
              </ToggleGroup.Root>
            </Accordion.Content>
          </Accordion.Item>
        {:else}
          {@const channel = space.view.channels[item.id]}
          <ToggleGroup.Root
            type="single"
            class="flex flex-col gap-4 items-center"
          >
            <ToggleGroup.Item
              onclick={() => goto(`/space/${page.params.space}/${item.id}`)}
              value={item.id}
              class="w-full text-start hover:scale-105 transition-all duration-150 active:scale-95 hover:bg-white/5 border border-transparent data-[state=on]:border-white data-[state=on]:scale-98 data-[state=on]:bg-white/5 text-white px-4 py-2 rounded-md"
            >
              <h3># {channel.name}</h3>
            </ToggleGroup.Item>
          </ToggleGroup.Root>
        {/if}
      {/each}
    </Accordion.Root>
  </nav>

  <!-- Events/Room Content -->
  <main class="grow flex flex-col gap-4 bg-violet-950 rounded-lg p-4">
    {@render children()}
  </main>
{/if}
