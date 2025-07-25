<script lang="ts">
  import { atprotoFeedService } from "$lib/services/atprotoFeedService";
  import { RoomyAccount } from "@roomy-chat/sdk";
  import { AccountCoState } from "jazz-tools/svelte";
  import Icon from "@iconify/svelte";

  let {
    onViewThread,
  }: {
    onViewThread?: (postUri: string) => void;
  } = $props();

  // Get the current Jazz account
  const me = new AccountCoState(RoomyAccount, {
    resolve: {
      root: true,
    },
  });

  let bookmarks = $derived(() => {
    if (!me.current) return [];
    return atprotoFeedService.getBookmarks(me.current);
  });

  let searchQuery = $state("");
  let sortBy = $state<"date" | "author" | "feed">("date");
  let viewMode = $state<"list" | "grid">("list");

  let filteredBookmarks = $derived(() => {
    let filtered = bookmarks;

    // Apply search filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(bookmark => 
        bookmark.title.toLowerCase().includes(query) ||
        bookmark.author.handle.toLowerCase().includes(query) ||
        bookmark.author.displayName?.toLowerCase().includes(query) ||
        bookmark.previewText.toLowerCase().includes(query)
      );
    }

    // Apply sorting
    filtered = [...filtered].sort((a, b) => {
      switch (sortBy) {
        case "date":
          return new Date(b.bookmarkedAt).getTime() - new Date(a.bookmarkedAt).getTime();
        case "author":
          return (a.author.displayName || a.author.handle).localeCompare(b.author.displayName || b.author.handle);
        case "feed":
          return (a.feedSource || "").localeCompare(b.feedSource || "");
        default:
          return 0;
      }
    });

    return filtered;
  });

  function removeBookmark(postUri: string) {
    if (!me.current) return;
    atprotoFeedService.removeBookmark(me.current, postUri);
  }

  function viewThread(postUri: string) {
    if (onViewThread) {
      onViewThread(postUri);
    }
  }

  function getRelativeTime(dateString: string | Date): string {
    const date = new Date(dateString);
    const now = new Date();
    const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

    if (diffInSeconds < 60) return "just now";
    if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)}m ago`;
    if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)}h ago`;
    if (diffInSeconds < 604800) return `${Math.floor(diffInSeconds / 86400)}d ago`;
    return `${Math.floor(diffInSeconds / 604800)}w ago`;
  }

  function getFeedDisplayName(feedSource?: string): string {
    if (!feedSource) return "📡 ATProto Feed";
    return atprotoFeedService.getFeedName(feedSource);
  }
</script>

<div class="flex-1 flex flex-col h-full overflow-hidden">
  <!-- Header -->
  <div class="flex-shrink-0 p-6 border-b border-base-300 dark:border-base-700">
    <div class="flex items-center justify-between mb-4">
      <h2 class="text-xl font-bold flex items-center gap-2">
        <Icon icon="mdi:bookmark" class="text-yellow-500" />
        Bookmarked Threads
      </h2>
      <div class="flex items-center gap-2">
        <button
          onclick={() => viewMode = viewMode === "list" ? "grid" : "list"}
          class="px-3 py-1.5 text-sm border border-base-300 dark:border-base-700 rounded-md hover:bg-base-100 dark:hover:bg-base-800 transition-colors"
          title={`Switch to ${viewMode === "list" ? "grid" : "list"} view`}
        >
          <Icon icon={viewMode === "list" ? "mdi:grid" : "mdi:format-list-bulleted"} />
        </button>
      </div>
    </div>

    <!-- Controls -->
    <div class="flex items-center gap-4">
      <!-- Search -->
      <div class="flex-1 relative">
        <Icon icon="mdi:magnify" class="absolute left-3 top-1/2 transform -translate-y-1/2 text-base-content/60 size-4" />
        <input
          type="text"
          bind:value={searchQuery}
          placeholder="Search bookmarks..."
          class="w-full pl-10 pr-4 py-2 text-sm border border-base-200 dark:border-base-700 rounded-md bg-base-50 dark:bg-base-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <!-- Sort -->
      <select
        bind:value={sortBy}
        class="px-3 py-2 text-sm border border-base-200 dark:border-base-700 rounded-md bg-base-50 dark:bg-base-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
      >
        <option value="date">Sort by Date</option>
        <option value="author">Sort by Author</option>
        <option value="feed">Sort by Feed</option>
      </select>
    </div>
  </div>

  <!-- Content -->
  <div class="flex-1 overflow-y-auto p-6">
    {#if bookmarks.length === 0}
      <div class="text-center py-8 text-base-content/60">
        <Icon icon="mdi:bookmark-outline" class="size-12 mx-auto mb-2" />
        <p>No bookmarked threads yet</p>
        <p class="text-sm mt-2">
          Bookmark interesting threads from feeds to save them for later reading
        </p>
      </div>
    {:else if filteredBookmarks.length === 0}
      <div class="text-center py-8 text-base-content/60">
        <Icon icon="mdi:magnify" class="size-12 mx-auto mb-2" />
        <p>No bookmarks match your search</p>
        <p class="text-sm mt-2">
          Try different keywords or clear your search
        </p>
      </div>
    {:else}
      <div class={viewMode === "grid" ? "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4" : "space-y-4"}>
        {#each filteredBookmarks as bookmark (bookmark.postUri)}
          <div
            class="bg-white dark:bg-base-800 border border-base-200 dark:border-base-700 rounded-lg shadow-sm transition-all hover:shadow-md cursor-pointer"
            onclick={() => viewThread(bookmark.postUri)}
          >
            <div class="p-4">
              <!-- Header -->
              <div class="flex items-start justify-between mb-3">
                <div class="flex items-center gap-3 flex-1 min-w-0">
                  {#if bookmark.author.avatar}
                    <img
                      src={bookmark.author.avatar}
                      alt={bookmark.author.displayName || bookmark.author.handle}
                      class="size-8 rounded-full object-cover flex-shrink-0"
                    />
                  {:else}
                    <div class="size-8 rounded-full bg-base-300 flex items-center justify-center flex-shrink-0">
                      <Icon icon="mdi:account" class="size-4" />
                    </div>
                  {/if}
                  <div class="flex-1 min-w-0">
                    <div class="font-medium text-sm truncate">
                      {bookmark.author.displayName || bookmark.author.handle}
                    </div>
                    <div class="text-xs text-base-content/60 truncate">
                      @{bookmark.author.handle}
                    </div>
                  </div>
                </div>
                <button
                  onclick={(e) => {
                    e.stopPropagation();
                    removeBookmark(bookmark.postUri);
                  }}
                  class="flex-shrink-0 p-1 text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded transition-colors"
                  title="Remove bookmark"
                >
                  <Icon icon="mdi:close" class="size-4" />
                </button>
              </div>

              <!-- Content -->
              <div class="mb-3">
                <h3 class="font-medium text-sm mb-1 line-clamp-2">
                  {bookmark.title}
                </h3>
                <p class="text-xs text-base-content/70 line-clamp-3">
                  {bookmark.previewText}
                </p>
              </div>

              <!-- Footer -->
              <div class="flex items-center justify-between text-xs text-base-content/60">
                <div class="flex items-center gap-2">
                  <span class="inline-flex items-center gap-1 px-2 py-0.5 bg-accent-100 dark:bg-accent-900/30 text-accent-800 dark:text-accent-200 rounded-full">
                    <Icon icon="mdi:rss" class="size-3" />
                    {getFeedDisplayName(bookmark.feedSource)}
                  </span>
                </div>
                <span title={new Date(bookmark.bookmarkedAt).toLocaleString()}>
                  {getRelativeTime(bookmark.bookmarkedAt)}
                </span>
              </div>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>

  <!-- Footer -->
  {#if bookmarks.length > 0}
    <div class="flex-shrink-0 px-6 py-3 border-t border-base-300 dark:border-base-700 bg-base-50 dark:bg-base-800/50">
      <div class="flex items-center justify-between text-sm text-base-content/60">
        <span>
          {filteredBookmarks.length} of {bookmarks.length} bookmarks
          {searchQuery.trim() ? `matching "${searchQuery}"` : ""}
        </span>
        {#if searchQuery.trim()}
          <button
            onclick={() => searchQuery = ""}
            class="text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
          >
            Clear search
          </button>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .line-clamp-2 {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  
  .line-clamp-3 {
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
</style>