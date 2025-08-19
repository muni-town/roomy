<script lang="ts">
  import {
    ATPROTO_FEED_CONFIG,
    ATPROTO_FEEDS,
    addFeedToList,
  } from "$lib/utils/atprotoFeeds";
  import { atprotoFeedService } from "$lib/services/atprotoFeedService";
  import { RoomyAccount } from "@roomy-chat/sdk";
  import { AccountCoState } from "jazz-tools/svelte";
  import Icon from "@iconify/svelte";

  let {
    objectId,
    readonly = false,
  }: {
    objectId: string;
    readonly?: boolean;
  } = $props();

  let newFeedInput = $state("");
  let feedConfigLoading = $state(false);

  // Get the current Jazz account
  const me = new AccountCoState(RoomyAccount, {
    resolve: {
      root: true,
    },
  });

  // Get config from service with account state validation
  let config = $derived(() => {
    if (!me.current) {
      console.log("⏳ Account not loaded yet");
      return { feeds: [], threadsOnly: false };
    }
    return atprotoFeedService.getFeedConfig(me.current, objectId);
  });
  let feeds = $derived(config().feeds);
  let threadsOnly = $derived(config().threadsOnly);
  let accountLoaded = $derived(!!me.current);

  function updateConfig(
    updates: Partial<{ feeds: string[]; threadsOnly: boolean }>,
  ) {
    console.log(
      "🔧 updateConfig called:",
      updates,
      "accountLoaded:",
      accountLoaded,
    );

    if (!me.current) {
      console.error("❌ Cannot update config: Account not loaded");
      return;
    }

    const newConfig = {
      feeds,
      threadsOnly,
      ...updates,
    };

    console.log("🔧 Calling setFeedConfig with:", newConfig);
    atprotoFeedService.setFeedConfig(me.current, objectId, newConfig);
  }

  function getFeedDisplayName(feedUri: string): string {
    if (ATPROTO_FEED_CONFIG[feedUri]) {
      return ATPROTO_FEED_CONFIG[feedUri].name;
    }

    // Extract a display name from the URI
    const match = feedUri.match(/\/([^\/]+)$/);
    if (match && match[1]) {
      const feedName = match[1];
      return feedName
        .split("-")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
    }
    return `Feed (${feedUri.substring(0, 20)}...)`;
  }

  function addDefaultFeeds() {
    console.log("🔘 Add default feeds clicked");

    if (readonly || !accountLoaded) {
      console.log("❌ Cannot add feeds:", { readonly, accountLoaded });
      return;
    }

    feedConfigLoading = true;
    try {
      console.log("🔧 Adding default feeds:", ATPROTO_FEEDS);
      updateConfig({ feeds: ATPROTO_FEEDS });
      console.log("✅ Added default feeds");
    } catch (error) {
      console.error("❌ Error adding default feeds:", error);
    } finally {
      feedConfigLoading = false;
    }
  }

  function clearAllFeeds() {
    console.log("🔘 Clear all feeds clicked");

    if (readonly || !accountLoaded) {
      console.log("❌ Cannot clear feeds:", { readonly, accountLoaded });
      return;
    }

    feedConfigLoading = true;
    try {
      console.log("🔧 Clearing all feeds");
      updateConfig({ feeds: [] });
      console.log("✅ Cleared all feeds");
    } catch (error) {
      console.error("❌ Error clearing feeds:", error);
    } finally {
      feedConfigLoading = false;
    }
  }

  function toggleThreadsOnly() {
    if (readonly) return;

    try {
      updateConfig({ threadsOnly: !threadsOnly });
      console.log(`✅ Threads only: ${!threadsOnly}`);
    } catch (error) {
      console.error("❌ Error toggling threads only:", error);
    }
  }

  function addFeed() {
    if (readonly || !newFeedInput.trim()) return;

    try {
      const updatedFeeds = addFeedToList(
        newFeedInput.trim(),
        feeds,
        (uri) => {
          console.log(`✅ Added feed: ${uri}`);
        },
        (error) => {
          console.error(`❌ Error adding feed: ${error}`);
        },
      );

      updateConfig({ feeds: updatedFeeds });
      newFeedInput = "";
    } catch (error) {
      console.error("❌ Error adding feed:", error);
    }
  }

  function removeFeed(feedUri: string) {
    if (readonly) return;

    try {
      const updatedFeeds = feeds.filter((uri: string) => uri !== feedUri);
      updateConfig({ feeds: updatedFeeds });
      console.log(`✅ Removed feed: ${feedUri}`);
    } catch (error) {
      console.error("❌ Error removing feed:", error);
    }
  }
</script>

<div class="space-y-4">
  <!-- Feed Configuration Header -->
  <div>
    <h3 class="text-lg font-semibold flex items-center gap-2">
      <Icon icon="mdi:rss" class="text-blue-500" />
      Feed Settings
    </h3>
  </div>

  <!-- Current Status -->
  <div
    class="bg-base-100 dark:bg-base-800 rounded-lg p-4 border border-base-200 dark:border-base-700"
  >
    <div class="flex items-center justify-between">
      <div>
        {#if feeds.length > 0}
          <p class="font-medium">
            Status: <span class="text-green-600">Active</span>
          </p>
          <p class="text-sm text-base-content/60 mt-1">
            {feeds.length} feed{feeds.length !== 1 ? "s" : ""} configured
            {#if threadsOnly}• Threads only{/if}
          </p>
        {:else}
          <p class="font-medium">
            Status: <span class="text-base-500">No feeds configured</span>
          </p>
          <p class="text-sm text-base-content/60 mt-1">
            Add feeds to start displaying posts from ATProto
          </p>
        {/if}
      </div>
      {#if !readonly}
        <div class="flex gap-2">
          {#if feeds.length === 0}
            <button
              onclick={addDefaultFeeds}
              disabled={feedConfigLoading || !accountLoaded}
              class="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {feedConfigLoading
                ? "Adding..."
                : !accountLoaded
                  ? "Loading..."
                  : "Add Default Feeds"}
            </button>
          {:else}
            <button
              onclick={clearAllFeeds}
              disabled={feedConfigLoading || !accountLoaded}
              class="px-3 py-1.5 text-sm bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-50 transition-colors"
            >
              {feedConfigLoading
                ? "Clearing..."
                : !accountLoaded
                  ? "Loading..."
                  : "Clear All Feeds"}
            </button>
          {/if}
        </div>
      {/if}
    </div>
  </div>

  <!-- Configuration Panel -->
  {#if !readonly}
    <div
      class="bg-base-100 dark:bg-base-800 rounded-lg p-4 border border-base-200 dark:border-base-700 space-y-4"
    >
      <!-- Feed Options -->
      <div>
        <label class="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={threadsOnly}
            onchange={toggleThreadsOnly}
            class="checkbox checkbox-sm"
          />
          <span class="text-sm">Show only posts with replies (threads)</span>
        </label>
      </div>

      <!-- Add Custom Feed -->
      <div>
        <label for="text" class="block text-sm font-medium mb-2"
          >Add Custom Feed</label
        >
        <div class="flex gap-2">
          <input
            name="text"
            type="text"
            bind:value={newFeedInput}
            placeholder="Feed URL or AT:// URI"
            class="flex-1 input input-sm input-bordered"
            onkeydown={(e) => e.key === "Enter" && addFeed()}
          />
          <button
            onclick={addFeed}
            disabled={!newFeedInput.trim()}
            class="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            <Icon icon="mdi:plus" class="size-4" />
            Add
          </button>
        </div>
        <p class="text-xs text-base-content/60 mt-1">
          Enter a Bluesky feed URL or AT Proto URI
        </p>
      </div>

      <!-- Quick Actions -->
      <div class="flex gap-2">
        <button
          onclick={addDefaultFeeds}
          class="px-3 py-1.5 text-sm border border-base-300 dark:border-base-700 rounded-md hover:bg-base-100 dark:hover:bg-base-800 transition-colors"
        >
          <Icon icon="mdi:star" class="size-4 inline mr-1" />
          Add Default Feeds
        </button>
        {#if feeds.length > 0}
          <button
            onclick={clearAllFeeds}
            class="px-3 py-1.5 text-sm border border-red-300 dark:border-red-700 text-red-600 dark:text-red-400 rounded-md hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
          >
            <Icon icon="mdi:trash" class="size-4 inline mr-1" />
            Clear All
          </button>
        {/if}
      </div>

      <!-- Current Feeds List -->
      {#if feeds && feeds.length > 0}
        <div>
          <h4 class="text-sm font-medium mb-2">Configured Feeds</h4>
          <div class="space-y-2 max-h-64 overflow-y-auto">
            {#each feeds as feedUri}
              <div
                class="flex items-center justify-between gap-3 p-2 bg-base-200 dark:bg-base-700 rounded"
              >
                <div class="flex-1 min-w-0">
                  <div class="text-sm font-medium truncate">
                    {getFeedDisplayName(feedUri)}
                  </div>
                  <div class="text-xs text-base-content/60 truncate">
                    {feedUri}
                  </div>
                </div>
                <button
                  onclick={() => removeFeed(feedUri)}
                  class="px-2 py-1 text-xs text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded transition-colors"
                  title="Remove this feed"
                >
                  <Icon icon="mdi:close" class="size-4" />
                </button>
              </div>
            {/each}
          </div>
        </div>
      {/if}
    </div>
  {/if}

  <!-- Help Text -->
  {#if feeds.length === 0}
    <div
      class="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4"
    >
      <div class="flex items-start gap-3">
        <Icon
          icon="mdi:information"
          class="text-blue-600 dark:text-blue-400 size-5 flex-shrink-0 mt-0.5"
        />
        <div>
          <p class="text-sm text-blue-800 dark:text-blue-200 font-medium">
            About Feed Threads
          </p>
          <p class="text-xs text-blue-700 dark:text-blue-300 mt-1">
            Feed threads display posts from ATProto feeds (like Bluesky). Add
            feeds to start seeing posts from configured feeds.
          </p>
        </div>
      </div>
    </div>
  {/if}
</div>
