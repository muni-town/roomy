<script lang="ts">
  import { page } from "$app/state";

  import { g } from "$lib/global.svelte";

  import { navigateSync } from "$lib/utils.svelte";
  import Icon from "@iconify/svelte";
  import { Category, Channel } from "@roomy-chat/sdk";
  import { Accordion, Button } from "bits-ui";
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

<div transition:slide={{ duration: 100 }} class="flex flex-col gap-2 px-2">
  <!-- Category and Channels -->
  {#each sidebarItems.value.filter((x: { softDeleted?: boolean }) => !x.softDeleted) as item}
    {@const category = item.tryCast(Category)}
    {#if category}
      <Accordion.Root type="single" value={item.name}>
        <Accordion.Item value={item.name}>
          <Accordion.Header class="flex w-full justify-between">
            <Accordion.Trigger
              class="flex text-sm max-w-full uppercase truncate gap-2 items-center justify-start cursor-pointer"
            >
              <Icon icon="basil:folder-solid" class="shrink-0" />
              <span class="truncate">{item.name}</span>
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
                    <Icon icon="lucide:settings" class="size-4 shrink-0" />
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
                      type="text"
                      required
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
              props: Record<string, any>;
            })}
              {#if open}
                <div
                  {...props}
                  transition:slide={{ duration: 100 }}
                  class="flex flex-col gap-2"
                >
                  {#each category.channels.ids() as channelId}
                    {#await g.roomy && g.roomy.open(Channel, channelId) then channel}
                      {#if !channel?.softDeleted}
                        <Button.Root
                          href={navigateSync({
                            space: page.params.space!,
                            channel: channelId,
                          })}
                          class="w-full cursor-pointer px-1 dz-btn dz-btn-ghost justify-start border page.params.channel && {channelId ===
                          page.params.channel
                            ? 'border-primary text-primary'
                            : ' border-transparent'}"
                        >
                          <h3
                            class="flex justify-start items-center w-full gap-2 px-2"
                          >
                            <Icon icon="basil:comment-solid" class="shrink-0" />
                            <span class="truncate"
                              >{channel?.name || "..."}</span
                            >
                          </h3>
                        </Button.Root>
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
      <Button.Root
        href={navigateSync({
          space: page.params.space!,
          channel: item.id,
        })}
        class="w-full cursor-pointer px-1 dz-btn dz-btn-ghost justify-start border page.params.channel && {item.id ===
        page.params.channel
          ? 'border-primary text-primary'
          : ' border-transparent'}"
      >
        <h3 class="flex justify-start items-center w-full gap-2">
          <Icon icon="basil:comment-solid" class="shrink-0" />
          <span class="truncate"> {item.name} </span>
        </h3>
      </Button.Root>
    {/if}
  {/each}
</div>
