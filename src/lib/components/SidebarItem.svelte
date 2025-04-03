<script lang="ts">
  import { slide } from "svelte/transition";
  import Icon from "@iconify/svelte";
  import { Accordion, Button, Dialog, ToggleGroup } from "bits-ui";
  import { g, storage } from "$lib/global.svelte";
  import { goto } from "$app/navigation";
  import { Category, Channel } from "@roomy-chat/sdk";
  import { page } from "$app/state";

  let { item }: { item: any } = $props();

  let showCategoryDialog = $state(false);
  let editingCategory = $state<Category | null>(null);
  let categoryNameInput = $state("");
  let category = item.tryCast(Category);
  let init_count = storage.getItem(item.id) || "0";
  let unread = $state(parseInt(init_count));

  storage.subscribe(item.id, (newValue: number, oldValue: number) => {
    console.log(newValue, oldValue);
    unread = newValue;
  });

  function saveCategory(event: SubmitEvent) {
    event.preventDefault();
    console.log("Saving category...", editingCategory?.id, categoryNameInput);
    showCategoryDialog = false;
  }

  function navigate(params: { space: string; channel: string }) {
    goto(`/${params.space}/${params.channel}`);
  }
</script>

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

            <form class="flex flex-col gap-4 w-full" onsubmit={saveCategory}>
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
        {#snippet child({ props, open }: { open: boolean; props: unknown[] })}
          {#if open}
            <div {...props} transition:slide class="flex flex-col gap-4 py-2">
              {#each category.channels.ids() as channelId}
                <ToggleGroup.Item
                  onclick={() => {
                    navigate({
                      space: page.params.space!,
                      channel: channelId,
                    });
                  }}
                  value={channelId}
                  class="w-full cursor-pointer px-1 btn btn-ghost justify-start border border-transparent data-[state=on]:border-primary data-[state=on]:text-primary"
                >
                  <h3 class="flex justify-start items-center gap-2 px-2">
                    <Icon icon="basil:comment-solid" />
                    {#await g.roomy && g.roomy.open(Channel, channelId)}
                      ...
                    {:then channel}
                      {channel?.name}
                    {/await}
                  </h3>
                </ToggleGroup.Item>
              {/each}
            </div>
          {/if}
        {/snippet}
      </Accordion.Content>
    </Accordion.Item>
  </Accordion.Root>
{:else if item.matches(Channel)}
  <ToggleGroup.Item
    onclick={() => {
      console.log("clerp");
      storage.setItem(item.id, 0);
      navigate({
        space: page.params.space!,
        channel: item.id,
      });
    }}
    value={item.id}
    class="w-full cursor-pointer px-1 btn btn-ghost justify-start border border-transparent data-[state=on]:border-primary data-[state=on]:text-primary"
  >
    <h3 class="flex justify-start items-center gap-2 px-2">
      <Icon icon="basil:comment-solid" />
      {item.name}
      {#if unread > 0}
        ({unread})
      {/if}
    </h3>
  </ToggleGroup.Item>
{/if}
