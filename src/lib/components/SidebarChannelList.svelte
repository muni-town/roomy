<script lang="ts">
  import { page } from "$app/state";

  import { g } from "$lib/global.svelte";

  import { navigate } from "$lib/utils.svelte";
  import Icon from "@iconify/svelte";
  import { Category, Channel } from "@roomy-chat/sdk";
  import { Accordion, Button, ToggleGroup } from "bits-ui";
  import { slide } from "svelte/transition";
  import Dialog from "./Dialog.svelte";

  let { sidebarItems } = $props();

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

<div transition:slide class="flex flex-col gap-4">
  <!-- Category and Channels -->
  {#each sidebarItems.value.filter((x) => !x.softDeleted) as item}
    {@const category = item.tryCast(Category)}
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
                    class="cursor-pointer dz-btn dz-btn-ghost dz-btn-circle"
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
                  <label class="dz-input w-full">
                    <span class="label">Name</span>
                    <input
                      bind:value={categoryNameInput}
                      placeholder="channel-name"
                    />
                  </label>
                  <Button.Root
                    disabled={!categoryNameInput}
                    class="dz-btn dz-btn-primary"
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
                          class="w-full cursor-pointer px-1 dz-btn dz-btn-ghost justify-start border border-transparent data-[state=on]:border-primary data-[state=on]:text-primary"
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
        class="w-full cursor-pointer px-1 dz-btn dz-btn-ghost justify-start border border-transparent data-[state=on]:border-primary data-[state=on]:text-primary"
      >
        <h3 class="flex justify-start items-center gap-2 px-2">
          <Icon icon="basil:comment-solid" />
          {item.name}
        </h3>
      </ToggleGroup.Item>
    {/if}
  {/each}
</div>
