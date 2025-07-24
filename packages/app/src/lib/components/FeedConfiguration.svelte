<script lang="ts">
  import { co, z } from "jazz-tools";
  import { RoomyEntity, isSpaceAdmin } from "@roomy-chat/sdk";
  import {
    ATPROTO_FEED_CONFIG,
    ATPROTO_FEEDS,
    addFeedToList,
  } from "$lib/utils/atproToFeeds";
  import Icon from "@iconify/svelte";
  import { CoState } from "jazz-tools/svelte";
  import { page } from "$app/state";

  let {
    thread,
  }: {
    thread: co.loaded<typeof RoomyEntity> | null | undefined;
  } = $props();

  // Get the current space for admin check
  let space = $derived(new CoState(RoomyEntity, page.params.space, {
    resolve: {
      components: true,
    },
  }));

  let newFeedInput = $state("");
  let feedConfigLoading = $state(false);

  // Parse current feed configuration
  let feedConfig = $derived(() => {
    if (!thread?.components?.feedConfig) {
      return {
        feeds: [],
        threadsOnly: false,
      };
    }
    try {
      const config = JSON.parse(thread.components.feedConfig);
      // Remove enabled field from existing configs during migration
      const { enabled, ...cleanConfig } = config;
      return {
        feeds: cleanConfig.feeds || [],
        threadsOnly: cleanConfig.threadsOnly || false,
      };
    } catch {
      return {
        feeds: [],
        threadsOnly: false,
      };
    }
  });

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
    return "Custom Feed";
  }

  function addDefaultFeeds() {
    if (!thread || !isSpaceAdmin(space.current)) return;

    feedConfigLoading = true;
    try {
      const newConfig = {
        ...feedConfig(),
        feeds: ATPROTO_FEEDS,
      };

      thread.components.feedConfig = JSON.stringify(newConfig);
      console.log("✅ Added default feeds");
    } catch (error) {
      console.error("❌ Error adding default feeds:", error);
    } finally {
      feedConfigLoading = false;
    }
  }

  function clearAllFeeds() {
    if (!thread || !isSpaceAdmin(space.current)) return;

    feedConfigLoading = true;
    try {
      const newConfig = {
        ...feedConfig(),
        feeds: [],
      };

      thread.components.feedConfig = JSON.stringify(newConfig);
      console.log("✅ Cleared all feeds");
    } catch (error) {
      console.error("❌ Error clearing feeds:", error);
    } finally {
      feedConfigLoading = false;
    }
  }

  function toggleThreadsOnly() {
    if (!thread || !isSpaceAdmin(space.current)) return;

    try {
      const newConfig = {
        ...feedConfig(),
        threadsOnly: !feedConfig().threadsOnly,
      };

      thread.components.feedConfig = JSON.stringify(newConfig);
      console.log(`✅ Threads only: ${newConfig.threadsOnly}`);
    } catch (error) {
      console.error("❌ Error toggling threads only:", error);
    }
  }

  function addFeed() {
    if (!thread || !isSpaceAdmin(space.current) || !newFeedInput.trim()) return;

    try {
      const currentConfig = feedConfig();
      const updatedFeeds = addFeedToList(
        newFeedInput.trim(),
        currentConfig.feeds || [],
        (uri) => {
          console.log(`✅ Added feed: ${uri}`);
        },
        (error) => {
          console.error(`❌ Error adding feed: ${error}`);
        }
      );

      const newConfig = {
        ...currentConfig,
        feeds: updatedFeeds,
      };

      thread.components.feedConfig = JSON.stringify(newConfig);
      newFeedInput = "";
    } catch (error) {
      console.error("❌ Error adding feed:", error);
    }
  }

  function removeFeed(feedUri: string) {
    if (!thread || !isSpaceAdmin(space.current)) return;

    try {
      const currentConfig = feedConfig();
      const updatedFeeds = currentConfig.feeds.filter((uri: string) => uri !== feedUri);

      const newConfig = {
        ...currentConfig,
        feeds: updatedFeeds,
      };

      thread.components.feedConfig = JSON.stringify(newConfig);
      console.log(`✅ Removed feed: ${feedUri}`);
    } catch (error) {
      console.error("❌ Error removing feed:", error);
    }
  }

</script>

{#if thread}
  <div class="space-y-4">
    <!-- Feed Configuration Header -->
    <div>
      <h3 class="text-lg font-semibold flex items-center gap-2">
        <Icon icon="mdi:rss" class="text-blue-500" />
        Feed Settings
      </h3>
    </div>

    <!-- Current Status -->
    <div class="bg-base-100 dark:bg-base-800 rounded-lg p-4 border border-base-200 dark:border-base-700">
      <div class="flex items-center justify-between">
        <div>
          {#if feedConfig().feeds?.length > 0}
            <p class="font-medium">
              Status: <span class="text-green-600">Active</span>
            </p>
            <p class="text-sm text-base-content/60 mt-1">
              {feedConfig().feeds.length} feed{feedConfig().feeds.length !== 1 ? "s" : ""} configured
              {#if feedConfig().threadsOnly}• Threads only{/if}
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
        {#if isSpaceAdmin(space.current)}
          <div class="flex gap-2">
            {#if feedConfig().feeds?.length === 0}
              <button
                onclick={addDefaultFeeds}
                disabled={feedConfigLoading}
                class="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                {feedConfigLoading ? "Adding..." : "Add Default Feeds"}
              </button>
            {:else}
              <button
                onclick={clearAllFeeds}
                disabled={feedConfigLoading}
                class="px-3 py-1.5 text-sm bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-50 transition-colors"
              >
                {feedConfigLoading ? "Clearing..." : "Clear All Feeds"}
              </button>
            {/if}
          </div>
        {/if}
      </div>
    </div>

    <!-- Configuration Panel -->
    {#if isSpaceAdmin(space.current)}
      <div class="bg-base-100 dark:bg-base-800 rounded-lg p-4 border border-base-200 dark:border-base-700 space-y-4">
        <!-- Feed Options -->
        <div>
          <label class="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={feedConfig().threadsOnly}
              onchange={toggleThreadsOnly}
              class="checkbox checkbox-sm"
            />
            <span class="text-sm">Show only posts with replies (threads)</span>
          </label>
        </div>

        <!-- Add Custom Feed -->
        <div>
          <label class="block text-sm font-medium mb-2">Add Custom Feed</label>
          <div class="flex gap-2">
            <input
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
          {#if feedConfig().feeds?.length > 0}
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
        {#if feedConfig().feeds && feedConfig().feeds.length > 0}
          <div>
            <h4 class="text-sm font-medium mb-2">Configured Feeds</h4>
            <div class="space-y-2 max-h-64 overflow-y-auto">
              {#each feedConfig().feeds as feedUri}
                <div class="flex items-center justify-between gap-3 p-2 bg-base-200 dark:bg-base-700 rounded">
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
    {#if feedConfig().feeds?.length === 0}
      <div class="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
        <div class="flex items-start gap-3">
          <Icon icon="mdi:information" class="text-blue-600 dark:text-blue-400 size-5 flex-shrink-0 mt-0.5" />
          <div>
            <p class="text-sm text-blue-800 dark:text-blue-200 font-medium">About Feed Threads</p>
            <p class="text-xs text-blue-700 dark:text-blue-300 mt-1">
              Feed threads display posts from ATProto feeds (like Bluesky). Add feeds to start seeing posts from configured feeds.
              Users can click on posts to create discussion threads.
            </p>
          </div>
        </div>
      </div>
    {/if}
  </div>
{:else}
  <div class="text-center py-8 text-base-content/60">
    <Icon icon="mdi:loading" class="size-6 animate-spin mx-auto mb-2" />
    <p>Loading thread...</p>
  </div>
{/if}