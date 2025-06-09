<script lang="ts">
  import Icon from "@iconify/svelte";
  import { Category, Channel, RoomyAccount, Space } from "$lib/jazz/schema";
  import { Accordion, Button } from "bits-ui";
  import { slide } from "svelte/transition";
  import Dialog from "./Dialog.svelte";
  import { co } from "jazz-tools";
  import { isSpaceAdmin } from "$lib/jazz/utils";
  import SidebarChannelButton from "./SidebarChannelButton.svelte";

  let {
    sidebarItems,
    space,
    me,
  }: {
    sidebarItems: (
      | {
          type: "channel";
          data: co.loaded<typeof Channel>;
        }
      | {
          type: "category";
          data: co.loaded<typeof Category>;
        }
    )[];
    space: co.loaded<typeof Space> | undefined | null;
    me: co.loaded<typeof RoomyAccount> | undefined | null;
  } = $props();

  //
  // Delete Channel/Thread
  //
  async function deleteItem(
    item: co.loaded<typeof Channel> | co.loaded<typeof Category>,
  ) {
    if (!confirm(`Are you sure you want to delete "${item.name}"?`)) return;
    item.softDeleted = true;
  }

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
            <Accordion.Header class="flex w-full justify-between group">
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
                    class="cursor-pointer dz-btn dz-btn-ghost dz-btn-circle text-error hover:bg-error/10 opacity-0 group-hover:opacity-100 transition-opacity"
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
                          editingCategory = item.data as co.loaded<
                            typeof Category
                          >;
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
                    {#each item.data.channels?.values() || [] as channel}
                      {#if channel}
                        <SidebarChannelButton
                          {channel}
                          {deleteItem}
                          {space}
                          lastReadDate={me?.root?.lastRead?.[channel.id]}
                          {me}
                        />
                      {/if}
                    {/each}
                  </div>
                {/if}
              {/snippet}
            </Accordion.Content>
          </Accordion.Item>
        </Accordion.Root>
      {:else}
        <SidebarChannelButton
          channel={item.data}
          {deleteItem}
          {space}
          lastReadDate={me?.root?.lastRead?.[item.data.id]}
          {me}
        />
      {/if}
    {/each}
  {/if}
</div>
