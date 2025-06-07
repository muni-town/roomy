<script lang="ts">
  import { page } from "$app/state";
  import { navigate } from "$lib/utils.svelte";
  import Icon from "@iconify/svelte";
  import { Popover, Button } from "bits-ui";
  import Dialog from "$lib/components/Dialog.svelte";
  import { toast } from "svelte-french-toast";
  import { threading } from "./TimelineView.svelte";
  import { isSpaceAdmin } from "$lib/jazz/utils";
  import { CoState } from "jazz-svelte";
  import { Channel, Space, Thread } from "$lib/jazz/schema";

  let { createThread, threadTitleInput = $bindable() } = $props();
  let showSettingsDialog = $state(false);
  let channelNameInput = $state("");
  let channelCategoryInput = $state(undefined) as undefined | string;

  let space = $derived(new CoState(Space, page.params.space))

  let channel = $derived(new CoState(Channel, page.params.channel))

  let thread = $derived(new CoState(Thread, page.params.thread))

  function saveSettings() {
  }
</script>

<menu class="relative flex items-center gap-3 px-2 w-fit justify-end">
  <Popover.Root bind:open={threading.active}>
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

  {#if isSpaceAdmin(space.current)}
    <Dialog
      title={thread.current
        ? "Thread Settings"
        : "Channel Settings"}
      bind:isDialogOpen={showSettingsDialog}
    >
      {#snippet dialogTrigger()}
        <Button.Root
          title={thread.current
          ? "Thread Settings"
          : "Channel Settings"}
          class="m-auto flex"
        >
          <Icon icon="lucide:settings" class="text-2xl" />
        </Button.Root>
      {/snippet}

      <form class="flex flex-col gap-4 w-full" onsubmit={saveSettings}>
        <label class="dz-input w-full">
          <span class="dz-label">Name</span>
          <input
            bind:value={channelNameInput}
            placeholder="name"
            type="text"
            required
          />
        </label>
        {#if space.current && channel.current}
          <select bind:value={channelCategoryInput} class="select">
            <option value={undefined}>None</option>
            <!-- {#await Space.sidebarItems(globalState.space) then sidebarItems}
              {@const categories = sidebarItems
                .map((x) => x.tryCast(Category))
                .filter((x) => !!x)}

              {#each categories as category}
                <option value={category.id}>{category.name}</option>
              {/each}
            {/await} -->
          </select>
        {/if}
        <Button.Root class="dz-btn dz-btn-primary">Save Settings</Button.Root>
      </form>

      <form
        onsubmit={(e) => {
          e.preventDefault();
          if (!channel.current) return;
          channel.current.softDeleted = true;
          // globalState.channel.commit();
          showSettingsDialog = false;
          navigate({ space: page.params.space! });
        }}
        class="flex flex-col gap-3 mt-3"
      >
        <h2 class="text-xl font-bold">Danger Zone</h2>
        <p>
          Deleting a {channel.current ? "channel" : "thread"} doesn't delete
          the data permanently, it just hides the thread from the UI.
        </p>
        <Button.Root class="dz-btn dz-btn-error"
          >Delete {channel.current ? "Channel" : "Thread"}</Button.Root
        >
      </form>
    </Dialog>
  {/if}
</menu>
