<script lang="ts">
  import { page } from "$app/state";
  import { navigateSync } from "$lib/utils.svelte";
  import Icon from "@iconify/svelte";
  import { Category, Channel, Space } from "$lib/jazz/schema";
  import { Accordion, Button } from "bits-ui";
  import { slide } from "svelte/transition";
  import Dialog from "./Dialog.svelte";
  import { co } from "jazz-tools";
  import { isSpaceAdmin } from "$lib/jazz/utils";

  let {
    sidebarItems,
    space,
  }: {
    sidebarItems: {
      type: "channel" | "category";
      data: co.loaded<typeof Channel> | co.loaded<typeof Category>;
    }[];
    space: co.loaded<typeof Space> | undefined | null;
  } = $props();

  //
  // Delete Channel/Thread
  //
  async function deleteItem(
    item: co.loaded<typeof Channel> | co.loaded<typeof Category>,
  ) {
    if (!confirm(`Are you sure you want to delete "${item.name}"?`)) return;
    item.softDeleted = true;
    // item.commit();
  }

  //
  // Category Edit Dialog
  //
  let showCategoryDialog = $state(false);
  let editingCategory = $state(undefined) as
    | undefined
    | co.loaded<typeof Category>;
  let categoryNameInput = $state("");
  function saveCategory() {
    if (!editingCategory) return;
    editingCategory.name = categoryNameInput;
    // editingCategory.commit();
    showCategoryDialog = false;
  }
</script>

<div transition:slide={{ duration: 100 }} class="flex flex-col gap-2 px-2">
  <!-- Category and Channels -->
  {#if sidebarItems}
    {#each sidebarItems.filter((item) => !item.data?.softDeleted) as item}
      {#if item.type === "category"}
        <Accordion.Root type="single" value={item.data.name}>
          <Accordion.Item value={item.data.name}>
            <Accordion.Header class="flex w-full justify-between">
              <Accordion.Trigger
                class="flex text-sm max-w-full uppercase truncate gap-2 my-2 w-full items-center justify-start cursor-pointer"
              >
                <Icon icon="basil:folder-solid" class="shrink-0" />
                <span class="truncate">{item.data.name}</span>
              </Accordion.Trigger>

              <div class="flex gap-1">
                {#if isSpaceAdmin(space)}
                  <Button.Root
                    title="Delete"
                    class="cursor-pointer dz-btn dz-btn-ghost dz-btn-circle text-error hover:bg-error/10"
                    onclick={() => deleteItem(item.data)}
                  >
                    <Icon icon="lucide:x" class="size-4" />
                  </Button.Root>
                  <Dialog
                    title="Channel Settings"
                    bind:isDialogOpen={showCategoryDialog}
                  >
                    {#snippet dialogTrigger()}
                      <Button.Root
                        title="Channel Settings"
                        class="cursor-pointer dz-btn dz-btn-ghost dz-btn-circle"
                        onclick={() => {
                          editingCategory = item.data as co.loaded<typeof Category>;
                          categoryNameInput = item.data.name;
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
              </div>
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
                    {#each item.data.channels as channel}
                      {#if !channel?.softDeleted}
                        <div class="group flex items-center gap-1">
                          <Button.Root
                            href={navigateSync({
                              space: page.params.space!,
                              channel: channel.id,
                            })}
                            class="flex-1 cursor-pointer px-1 dz-btn dz-btn-ghost justify-start border page.params.channel && {channel.id ===
                            page.params.channel
                              ? 'border-primary text-primary'
                              : ' border-transparent'}"
                          >
                            <h3
                              class="flex justify-start items-center w-full gap-2 px-2"
                            >
                              <Icon
                                icon="basil:comment-solid"
                                class="shrink-0"
                              />
                              <span class="truncate"
                                >{channel?.name || "..."}</span
                              >
                            </h3>
                          </Button.Root>
                          {#if isSpaceAdmin(space)}
                            <Button.Root
                              title="Delete"
                              class="opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer dz-btn dz-btn-ghost dz-btn-circle text-error hover:bg-error/10"
                              onclick={() => deleteItem(channel)}
                            >
                              <Icon icon="lucide:x" class="size-4" />
                            </Button.Root>
                          {/if}
                        </div>
                      {/if}
                    {/each}
                  </div>
                {/if}
              {/snippet}
            </Accordion.Content>
          </Accordion.Item>
        </Accordion.Root>
      {:else}
        <div class="group flex items-center gap-1">
          <Button.Root
            href={navigateSync({
              space: page.params.space!,
              channel: item.data.id,
            })}
            class="flex-1 cursor-pointer px-1 dz-btn dz-btn-ghost justify-start border page.params.channel && {item
              .data.id === page.params.channel
              ? 'border-primary text-primary'
              : ' border-transparent'}"
          >
            <h3 class="flex justify-start items-center w-full gap-2">
              <Icon icon="basil:comment-solid" class="shrink-0" />
              <span class="truncate"> {item.data.name} </span>
            </h3>
          </Button.Root>
          {#if isSpaceAdmin(space)}
            <Button.Root
              title="Delete"
              class="opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer dz-btn dz-btn-ghost dz-btn-circle text-error hover:bg-error/10"
              onclick={() => deleteItem(item.data)}
            >
              <Icon icon="lucide:x" class="size-4" />
            </Button.Root>
          {/if}
        </div>
      {/if}
    {/each}
  {/if}
</div>
