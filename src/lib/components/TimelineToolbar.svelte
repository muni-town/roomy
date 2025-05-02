<script lang="ts">
  import { page } from "$app/state";
  import { g } from "$lib/global.svelte";
  import { navigate } from "$lib/utils.svelte";
  import Icon from "@iconify/svelte";
  import { Channel, Category } from "@roomy-chat/sdk";
  import { Popover, Button } from "bits-ui";
  import Dialog from "$lib/components/Dialog.svelte";
  import { getContext, untrack } from "svelte";
  import { toast } from "svelte-french-toast";

  let { createThread, threadTitleInput = $bindable() } = $props();
  let isThreading: { value: false } = getContext("isThreading");
  let showSettingsDialog = $state(false);
  let channelNameInput = $state("");
  let channelCategoryInput = $state(undefined) as undefined | string;

  $effect(() => {
    if (!g.space) return;

    untrack(() => {
      channelNameInput = g.channel?.name || "";
      channelCategoryInput = undefined;
      g.space &&
        g.space.sidebarItems.items().then((items) => {
          for (const item of items) {
            const category = item.tryCast(Category);
            if (
              category &&
              g.channel &&
              category.channels.ids().includes(g.channel.id)
            ) {
              channelCategoryInput = category.id;
              return;
            }
          }
        });
    });
  });

  async function saveSettings() {
    if (!g.space || !g.channel) return;
    if (channelNameInput) {
      g.channel.name = channelNameInput;
      g.channel.commit();
    }

    if (g.channel instanceof Channel) {
      let foundChannelInSidebar = false;
      for (const [
        cursor,
        unknownItem,
      ] of await g.space.sidebarItems.itemCursors()) {
        const item =
          unknownItem.tryCast(Category) || unknownItem.tryCast(Channel);

        if (item instanceof Channel && item.id == g.channel.id) {
          foundChannelInSidebar = true;
        }

        if (item instanceof Category) {
          const categoryItems = item.channels.ids();
          if (item.id !== channelCategoryInput) {
            const thisChannelIdx = categoryItems.indexOf(g.channel.id);
            if (thisChannelIdx != -1) {
              item.channels.remove(thisChannelIdx);
              item.commit();
            }
          } else if (
            item.id == channelCategoryInput &&
            !categoryItems.includes(g.channel.id)
          ) {
            item.channels.push(g.channel);
            item.commit();
          }
        } else if (
          item instanceof Channel &&
          channelCategoryInput &&
          item.id == g.channel.id
        ) {
          const { offset } = g.space.entity.doc.getCursorPos(cursor);
          g.space.sidebarItems.remove(offset);
        }
      }

      if (!channelCategoryInput && !foundChannelInSidebar) {
        g.space.sidebarItems.push(g.channel);
      }
      g.space.commit();
    }

    showSettingsDialog = false;
  }
</script>

<menu class="relative flex items-center gap-3 px-2 w-fit justify-end">
  <Popover.Root bind:open={isThreading.value}>
    <Popover.Trigger>
      <Icon icon="tabler:needle-thread" class="text-2xl" />
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content
        side="left"
        sideOffset={16}
        interactOutsideBehavior="ignore"
        class="my-4 bg-base-300 rounded py-4 px-5 max-w-[300px] w-full"
      >
        <div class="flex flex-col gap-4">
          <div class="flex justify-between items-center">
            <h2 class="text-xl font-bold">Create Thread</h2>
            <Popover.Close>
              <Icon icon="lucide:x" class="text-2xl" />
            </Popover.Close>
          </div>
          <p class="text-sm text-base-content">
            Threads are a way to organize messages in a channel. Select as many
            messages as you want and join them into a new thread.
          </p>
          <form onsubmit={createThread} class="flex flex-col gap-4">
            <input
              type="text"
              bind:value={threadTitleInput}
              class="dz-input"
              placeholder="Thread Title"
              required
            />
            <button type="submit" class="dz-btn dz-btn-primary">
              Create Thread
            </button>
          </form>
        </div>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>

  <Button.Root
    title="Copy invite link"
    onclick={() => {
      navigator.clipboard.writeText(`${page.url.href}`);
      toast.success("Invite link copied to clipboard");
    }}
  >
    <Icon icon="icon-park-outline:people-plus" class="text-2xl" />
  </Button.Root>

  {#if g.isAdmin}
    <Dialog
      title={g.channel instanceof Channel
        ? "Channel Settings"
        : "Thread Settings"}
      bind:isDialogOpen={showSettingsDialog}
    >
      {#snippet dialogTrigger()}
        <Button.Root
          title={g.channel instanceof Channel
            ? "Channel Settings"
            : "Thread Settings"}
          class="m-auto flex"
        >
          <Icon icon="lucide:settings" class="text-2xl" />
        </Button.Root>
      {/snippet}

      <form class="flex flex-col gap-4 w-full" onsubmit={saveSettings}>
        <label class="dz-input w-full">
          <span class="dz-label">Name</span>
          <input bind:value={channelNameInput} placeholder="name" required />
        </label>
        {#if g.space && g.channel instanceof Channel}
          <select bind:value={channelCategoryInput} class="select">
            <option value={undefined}>None</option>
            {#await g.space.sidebarItems.items() then sidebarItems}
              {@const categories = sidebarItems
                .map((x) => x.tryCast(Category))
                .filter((x) => !!x)}

              {#each categories as category}
                <option value={category.id}>{category.name}</option>
              {/each}
            {/await}
          </select>
        {/if}
        <Button.Root class="dz-btn dz-btn-primary">Save Settings</Button.Root>
      </form>

      <form
        onsubmit={(e) => {
          e.preventDefault();
          if (!g.channel) return;
          g.channel.softDeleted = true;
          g.channel.commit();
          showSettingsDialog = false;
          navigate({ space: page.params.space! });
        }}
        class="flex flex-col gap-3 mt-3"
      >
        <h2 class="text-xl font-bold">Danger Zone</h2>
        <p>
          Deleting a {g.channel instanceof Channel ? "channel" : "thread"} doesn't
          delete the data permanently, it just hides the thread from the UI.
        </p>
        <Button.Root class="dz-btn dz-btn-error"
          >Delete {g.channel instanceof Channel
            ? "Channel"
            : "Thread"}</Button.Root
        >
      </form>
    </Dialog>
  {/if}
</menu>
