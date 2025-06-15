<script lang="ts">
  import { page } from "$app/state";
  import { navigate } from "$lib/utils.svelte";
  import Icon from "@iconify/svelte";
  import { Button } from "@fuxui/base";
  import Dialog from "$lib/components/Dialog.svelte";
  import { toast } from "svelte-french-toast";
  import { isSpaceAdmin } from "$lib/jazz/utils";
  import { CoState } from "jazz-svelte";
  import { Channel, Space, Thread } from "$lib/jazz/schema";

  let {
    createThread,
    threadTitleInput = $bindable(),
    threading = $bindable(),
  } = $props();

  // Create reactive state for popover that syncs with threading
  let popoverOpen = $state(false);

  // Sync popover state with threading state
  $effect(() => {
    popoverOpen = threading?.active ?? false;
  });

  // Update threading when popover changes
  $effect(() => {
    if (threading) {
      threading.active = popoverOpen;
    }
  });
  let showSettingsDialog = $state(false);
  let channelNameInput = $state("");
  let channelCategoryInput = $state(undefined) as undefined | string;

  let space = $derived(new CoState(Space, page.params.space));

  let channel = $derived(new CoState(Channel, page.params.channel));

  let thread = $derived(new CoState(Thread, page.params.thread));

  function saveSettings() {}
</script>

<menu class="relative flex items-center gap-3 px-2 w-fit justify-end">
  <!-- Threading needle button -->
  <button
    type="button"
    onclick={() => {
      console.log("Needle clicked, current threading:", threading);
      console.log("Current popoverOpen:", popoverOpen);
      popoverOpen = !popoverOpen;
      console.log("New popoverOpen:", popoverOpen);
    }}
    class="p-2 hover:bg-base-200 rounded-lg transition-colors {threading?.active
      ? 'bg-primary text-primary-content'
      : ''}"
    title="Create Thread"
  >
    <Icon icon="tabler:needle-thread" class="text-2xl" />
  </button>

  <!-- Threading dialog -->
  {#if popoverOpen}
    <div
      class="fixed top-20 right-20 z-[100] bg-base-300 rounded-lg p-6 max-w-sm w-80 shadow-2xl border border-base-200"
    >
      <div class="flex flex-col gap-4">
        <div class="flex justify-between items-center">
          <h2 class="text-xl font-bold">Create Thread</h2>
          <button
            onclick={() => (popoverOpen = false)}
            class="hover:bg-base-200 p-1 rounded"
          >
            <Icon icon="lucide:x" class="text-lg" />
          </button>
        </div>
        <p class="text-sm text-base-content">
          Select messages below by clicking their checkboxes, then create a
          thread.
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
            Create Thread ({threading?.selectedMessages.length || 0} messages)
          </button>
        </form>
      </div>
    </div>
  {/if}

  <Button
    title="Copy invite link"
    onclick={() => {
      navigator.clipboard.writeText(`${page.url.href}`);
      toast.success("Invite link copied to clipboard");
    }}
  >
    <Icon icon="icon-park-outline:people-plus" class="text-2xl" />
  </Button>

  {#if isSpaceAdmin(space.current)}
    <Dialog
      title={thread.current ? "Thread Settings" : "Channel Settings"}
      bind:isDialogOpen={showSettingsDialog}
    >
      {#snippet dialogTrigger()}
        <Button
          title={thread.current ? "Thread Settings" : "Channel Settings"}
          class="m-auto flex"
        >
          <Icon icon="lucide:settings" class="text-2xl" />
        </Button>
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
        <Button class="dz-btn dz-btn-primary">Save Settings</Button>
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
          Deleting a {channel.current ? "channel" : "thread"} doesn't delete the
          data permanently, it just hides the thread from the UI.
        </p>
        <Button class="dz-btn dz-btn-error"
          >Delete {channel.current ? "Channel" : "Thread"}</Button
        >
      </form>
    </Dialog>
  {/if}
</menu>
