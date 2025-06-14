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
  import { ATPROTO_FEED_CONFIG, ATPROTO_FEEDS, addFeedToList } from "$lib/utils/atproToFeeds";

  let { createThread, threadTitleInput = $bindable() } = $props();
  let showSettingsDialog = $state(false);
  let channelNameInput = $state("");
  let channelCategoryInput = $state(undefined) as undefined | string;
  let selectedFeeds = $state<string[]>([]);
  let customFeedInput = $state(""); // For both URLs and URIs

  let space = $derived(new CoState(Space, page.params.space))

  let channel = $derived(new CoState(Channel, page.params.channel))

  let thread = $derived(new CoState(Thread, page.params.thread))

  // Populate form fields when dialog opens
  $effect(() => {
    if (showSettingsDialog && channel.current) {
      channelNameInput = channel.current.name || "";
      selectedFeeds = channel.current.atprotoFeedsConfig?.feeds || [];
      customFeedInput = ""; // Clear the input field when dialog opens
    }
  });

  function saveSettings(e: Event) {
    e.preventDefault();
    if (!channel.current) return;
    
    console.log("Saving channel settings:", {
      channelType: channel.current.channelType,
      selectedFeeds,
      currentConfig: channel.current.atprotoFeedsConfig
    });
    
    channel.current.name = channelNameInput;
    
    // Update feeds if this is a feeds channel
    if (channel.current.channelType === "feeds") {
      if (!channel.current.atprotoFeedsConfig) {
        channel.current.atprotoFeedsConfig = {
          feeds: selectedFeeds,
          threadsOnly: false
        };
      } else {
        channel.current.atprotoFeedsConfig.feeds = selectedFeeds;
      }
      
      console.log("After save - atprotoFeedsConfig:", channel.current.atprotoFeedsConfig);
    }
    
    showSettingsDialog = false;
    toast.success("Channel settings saved");
  }

  function toggleFeed(feedUri: string) {
    if (selectedFeeds.includes(feedUri)) {
      selectedFeeds = selectedFeeds.filter(uri => uri !== feedUri);
    } else {
      selectedFeeds = [...selectedFeeds, feedUri];
    }
  }

  function addCustomFeed() {
    selectedFeeds = addFeedToList(
      customFeedInput,
      selectedFeeds,
      (uri) => {
        toast.success(`Added feed: ${uri}`);
        customFeedInput = ""; // Clear the input on success
      },
      (error) => {
        alert(error);
      }
    );
  }

  function removeFeed(feedUri: string) {
    selectedFeeds = selectedFeeds.filter(uri => uri !== feedUri);
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

      <div class="max-h-[80vh] overflow-y-auto">
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
        
        {#if channel.current?.channelType === "feeds"}
          <div class="space-y-3 border-t pt-4">
            <h3 class="text-sm font-semibold">Feed Configuration</h3>
            
            <!-- Available feeds -->
            <div class="space-y-2">
              {#each Object.entries(ATPROTO_FEED_CONFIG) as [uri, config]}
                <label class="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedFeeds.includes(uri)}
                    onchange={() => toggleFeed(uri)}
                    class="checkbox checkbox-sm"
                  />
                  <div class="flex-1 min-w-0">
                    <div class="text-sm font-medium">{config.name}</div>
                    <div class="text-xs text-base-content/60 truncate">{config.url}</div>
                  </div>
                </label>
              {/each}
            </div>
            
            <!-- Custom feeds that aren't in the default list -->
            {#each selectedFeeds.filter(uri => !ATPROTO_FEEDS.includes(uri)) as customUri}
              <div class="flex items-center gap-2">
                <input type="checkbox" checked disabled class="checkbox checkbox-sm" />
                <span class="text-sm flex-1 truncate">{customUri}</span>
                <Button.Root
                  type="button"
                  onclick={() => removeFeed(customUri)}
                  class="dz-btn dz-btn-ghost dz-btn-sm text-error hover:bg-error/10"
                >
                  <Icon icon="tabler:x" class="size-3" />
                </Button.Root>
              </div>
            {/each}
            
            <!-- Add custom feed from URL or URI -->
            <div class="space-y-2">
              <h4 class="text-sm font-medium">Add Custom Feed</h4>
              <div class="flex gap-2">
                <input
                  type="text"
                  bind:value={customFeedInput}
                  placeholder="https://bsky.app/profile/did:plc:example/feed/feedname or at://..."
                  class="dz-input flex-1 text-xs"
                />
                <Button.Root
                  type="button"
                  onclick={addCustomFeed}
                  disabled={!customFeedInput}
                  class="dz-btn dz-btn-secondary dz-btn-sm"
                >
                  Add
                </Button.Root>
              </div>
              <p class="text-xs text-base-content/60">
                Accepts both Bluesky URLs and AT:// URIs
              </p>
            </div>
            
            <div class="text-xs text-base-content/60">
              Selected {selectedFeeds.length} feed{selectedFeeds.length !== 1 ? 's' : ''}
            </div>
          </div>
        {/if}
          <Button.Root class="dz-btn dz-btn-primary">Save Settings</Button.Root>
        </form>
      </div>

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
