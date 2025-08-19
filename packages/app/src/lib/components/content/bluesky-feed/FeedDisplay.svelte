<script lang="ts">
  import {
    ATPROTO_FEED_CONFIG,
    ATPROTO_FEEDS,
    type AtprotoThreadPost,
  } from "$lib/utils/atprotoFeeds";
  import { atprotoFeedService } from "$lib/services/atprotoFeedService";
  import type { AtprotoFeedPost } from "$lib/utils/atprotoFeeds";
  import { RoomyAccount } from "@roomy-chat/sdk";
  import { AccountCoState } from "jazz-tools/svelte";
  import Icon from "@iconify/svelte";
  import BookmarksModal from "./BookmarksModal.svelte";
  import HiddenItemsModal from "./HiddenItemsModal.svelte";

  let {
    objectId,
    singlePostUri,
  }: {
    objectId: string;
    singlePostUri?: string;
  } = $props();

  // Debug the singlePostUri prop
  $effect(() => {
    console.log("🔍 FeedDisplay props changed:", { objectId, singlePostUri });
  });

  let allFeedPosts = $state<AtprotoFeedPost[]>([]);
  let originalFeedPosts = $state<AtprotoFeedPost[]>([]); // Store original feed for back navigation
  let savedScrollPosition = $state(0); // Store scroll position for back navigation
  let loading = $state(true);
  let error = $state<string | null>(null);

  // Request cancellation controller
  let currentAbortController: AbortController | null = null;

  // Thread view state
  let showingThread = $state(false);
  let selectedPostUri = $state<string | null>(null);
  let threadLoading = $state(false);

  // Scroll container reference
  let scrollContainer: HTMLElement;

  // Modal states
  let showBookmarks = $state(false);
  let showHiddenItems = $state(false);

  // Get the current Jazz account
  const me = new AccountCoState(RoomyAccount, {
    resolve: {
      root: true,
    },
  });

  let feedPosts = $derived(
    allFeedPosts.filter(
      (post) => !atprotoFeedService.isHidden(me.current, post.uri),
    ),
  );

  let hiddenFeedPosts = $derived(
    allFeedPosts.filter((post) =>
      atprotoFeedService.isHidden(me.current, post.uri),
    ),
  );

  // Safe bookmark checking function
  function isPostBookmarked(post: AtprotoFeedPost): boolean {
    if (!me.current?.root) return false;
    return atprotoFeedService.isBookmarked(me.current, post.uri, objectId);
  }

  let bookmarks = $state<any[]>([]);

  // Update bookmarks when modal opens, account changes, or when viewing main feed
  $effect(() => {
    if (me.current && (showBookmarks || !showingThread)) {
      bookmarks = atprotoFeedService.getBookmarks(me.current, objectId);
    } else if (!me.current) {
      bookmarks = [];
    }
  });

  // Load feeds when component mounts or props change
  $effect(() => {
    console.log("🔍 FeedDisplay effect triggered - props:", {
      objectId,
      singlePostUri,
    });
    // Debounce the loading to prevent rapid-fire requests
    const timeoutId = setTimeout(() => {
      loadFeeds();
    }, 100);

    return () => clearTimeout(timeoutId);
  });

  async function loadFeeds() {
    // Cancel any existing request
    if (currentAbortController) {
      currentAbortController.abort();
    }

    // Create new abort controller for this request
    currentAbortController = new AbortController();
    const signal = currentAbortController.signal;

    // The abort controller cancellation above handles preventing multiple loads

    loading = true;
    error = null;

    try {
      // Check if request was aborted before proceeding
      if (signal.aborted) {
        return;
      }
      // Handle single post thread (either from prop or selected via click)
      const threadUri = singlePostUri || selectedPostUri;
      console.log("🔍 FeedDisplay loadFeeds - threadUri check:", {
        threadUri,
        singlePostUri,
        selectedPostUri,
      });
      if (threadUri) {
        console.log("🔍 FeedDisplay - Loading thread:", threadUri);
        const postThread = await atprotoFeedService.fetchPostThread(threadUri);
        if (postThread) {
          // Convert the entire thread to feed post format for display
          const threadPosts = [];

          // Add the main post
          const mainPost = {
            uri: threadUri,
            cid: postThread.cid || "",
            author: {
              did: postThread.author?.did || "",
              handle: postThread.author?.handle || "unknown",
              displayName:
                postThread.author?.displayName ||
                postThread.author?.handle ||
                "Unknown",
              avatar: postThread.author?.avatar || "",
            },
            record: {
              text: postThread.record?.text || "",
              createdAt:
                postThread.record?.createdAt || new Date().toISOString(),
            },
            replyCount: postThread.replies?.length || 0,
            repostCount: postThread.repostCount || 0,
            likeCount: postThread.likeCount || 0,
            indexedAt: postThread.indexedAt || new Date().toISOString(),
            feedSource: "thread-root",
            images: postThread.images || [],
            isThreadRoot: true,
          };
          threadPosts.push(mainPost);

          // Add all replies as separate posts
          if (postThread.replies && postThread.replies.length > 0) {
            const flattenReplies = (
              replies: NonNullable<AtprotoThreadPost["replies"]>,
              depth = 1,
            ) => {
              replies.forEach((reply) => {
                const replyPost = {
                  uri: reply.uri,
                  cid: reply.cid || "",
                  author: {
                    did: reply.author?.did || "",
                    handle: reply.author?.handle || "unknown",
                    displayName:
                      reply.author?.displayName ||
                      reply.author?.handle ||
                      "Unknown",
                    avatar: reply.author?.avatar || "",
                  },
                  record: {
                    text: reply.record?.text || "",
                    createdAt:
                      reply.record?.createdAt || new Date().toISOString(),
                  },
                  replyCount: reply.replies?.length || 0,
                  repostCount: reply.repostCount || 0,
                  likeCount: reply.likeCount || 0,
                  indexedAt: reply.indexedAt || new Date().toISOString(),
                  feedSource: "thread-reply",
                  images: reply.images || [],
                  isReply: true,
                  replyDepth: depth,
                };
                threadPosts.push(replyPost);

                if (reply.replies && reply.replies.length > 0) {
                  flattenReplies(reply.replies, depth + 1);
                }
              });
            };

            flattenReplies(postThread.replies);
          }
          allFeedPosts = threadPosts;
        } else {
          allFeedPosts = [];
        }
        return;
      }

      // Normal feed aggregation - use objectId to get config from Jazz root
      const posts = await atprotoFeedService.fetchFeedPostsForObject(
        me.current,
        objectId,
        50,
        signal,
      );

      // Check if request was aborted before setting results
      if (signal.aborted) {
        return;
      }

      allFeedPosts = posts;
      // Store original feed posts for back navigation (only if we're not showing a thread)
      if (!showingThread) {
        originalFeedPosts = posts;
      }
    } catch (err) {
      // Don't show error for aborted requests
      if (err instanceof Error && err.name === "AbortError") {
        return;
      }

      error = "Failed to load feeds";
      console.error("Feed loading error:", err);
    } finally {
      loading = false;
    }
  }

  function getRelativeTime(dateString: string): string {
    const date = new Date(dateString);
    const now = new Date();
    const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

    if (diffInSeconds < 60) return "just now";
    if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)}m ago`;
    if (diffInSeconds < 86400)
      return `${Math.floor(diffInSeconds / 3600)}h ago`;
    return `${Math.floor(diffInSeconds / 86400)}d ago`;
  }

  function getFeedName(feedSource?: string): string {
    if (!feedSource) {
      return "🔮 ATProto Feed";
    }

    return atprotoFeedService.getFeedName(feedSource);
  }

  function getFeedUrl(feedSource?: string): string {
    if (!feedSource) {
      return "#";
    }

    // Check if it's one of our predefined feeds
    if (ATPROTO_FEED_CONFIG[feedSource]) {
      return ATPROTO_FEED_CONFIG[feedSource].url;
    }

    // For custom feeds, generate Bluesky URL from AT Proto URI
    try {
      const uriMatch = feedSource.match(
        /at:\/\/([^\/]+)\/app\.bsky\.feed\.generator\/(.+)$/,
      );
      if (uriMatch) {
        const [, did, feedName] = uriMatch;
        return `https://bsky.app/profile/${did}/feed/${feedName}`;
      }
    } catch (e) {
      // Fall through to default
    }

    return "#";
  }

  function getBlueskyUrl(post: AtprotoFeedPost): string {
    return post.uri
      .replace("at://", "https://bsky.app/profile/")
      .replace("/app.bsky.feed.post/", "/post/");
  }

  async function showThread(postUri: string) {
    // Save current scroll position before switching to thread view
    if (scrollContainer) {
      savedScrollPosition = scrollContainer.scrollTop;
    }

    threadLoading = true;
    selectedPostUri = postUri;
    showingThread = true;

    try {
      // Load thread for the selected post
      await loadFeeds();
    } catch (err) {
      console.error("Failed to load thread:", err);
      error = "Failed to load thread";
    } finally {
      threadLoading = false;
    }
  }

  function handleViewThreadFromBookmarks(postUri: string) {
    showBookmarks = false;
    showThread(postUri);
  }

  function backToFeed() {
    showingThread = false;
    selectedPostUri = null;
    // Restore the original feed posts without refetching
    allFeedPosts = originalFeedPosts;

    // Restore scroll position after DOM updates
    setTimeout(() => {
      if (scrollContainer) {
        scrollContainer.scrollTop = savedScrollPosition;
      }
    }, 0);
  }

  function handleBookmark(post: AtprotoFeedPost) {
    if (!me.current) {
      console.error("❌ Cannot bookmark: Account not loaded");
      return;
    }

    if (!me.current.root) {
      console.error("❌ Cannot bookmark: Account root not loaded");
      return;
    }

    const isCurrentlyBookmarked = atprotoFeedService.isBookmarked(
      me.current,
      post.uri,
      objectId,
    );

    if (isCurrentlyBookmarked) {
      atprotoFeedService.removeBookmark(me.current, objectId, post.uri);
    } else {
      // Extract title from post text (first 50 chars or until newline)
      const title =
        (post.record.text.split("\n")[0] || "").substring(0, 50).trim() ||
        "Untitled Post";

      // Create preview text (first 100 chars)
      const previewText = post.record.text.substring(0, 100).trim();

      atprotoFeedService.bookmarkThread(me.current, objectId, post.uri, {
        title,
        author: {
          handle: post.author.handle,
          displayName: post.author.displayName,
          avatar: post.author.avatar,
        },
        previewText,
        feedSource: post.feedSource,
      });
    }
  }

  function handleHide(post: AtprotoFeedPost) {
    if (!me.current) {
      console.error("❌ Cannot hide: Account not loaded");
      return;
    }

    const isCurrentlyHidden = atprotoFeedService.isHidden(me.current, post.uri);

    if (isCurrentlyHidden) {
      atprotoFeedService.unhideThread(me.current, post.uri);
    } else {
      atprotoFeedService.hideThread(me.current, post.uri);
    }
  }
</script>

<div class="flex-1 flex flex-col h-full overflow-hidden">
  <div class="flex-shrink-0 p-6 border-b border-base-300 dark:border-base-700">
    <div class="flex items-center justify-between">
      <h2 class="text-xl font-bold flex items-center gap-2">
        <Icon icon="mdi:rss" class="text-blue-500" />
        {showingThread ? "Thread View" : "Feed Items"}
      </h2>
      <div class="flex items-center gap-2">
        {#if showingThread}
          <button
            onclick={backToFeed}
            class="px-3 py-1.5 text-sm bg-blue-600 text-white hover:bg-blue-700 rounded-md transition-colors flex items-center gap-2"
            disabled={loading}
          >
            <Icon icon="mdi:arrow-left" />
            Back to Feed
          </button>
        {:else}
          <button
            onclick={() => {
              showBookmarks = true;
            }}
            class="px-3 py-1.5 text-sm border border-base-300 dark:border-base-700 rounded-md hover:bg-base-100 dark:hover:bg-base-800 transition-colors flex items-center gap-2"
            title="Show bookmarks"
          >
            <Icon icon="mdi:bookmark" />
            Bookmarks
          </button>
          {#if hiddenFeedPosts.length > 0}
            <button
              onclick={() => (showHiddenItems = true)}
              class="px-3 py-1.5 text-sm border border-base-300 dark:border-base-700 rounded-md hover:bg-base-100 dark:hover:bg-base-800 transition-colors flex items-center gap-2"
              title="Show hidden items"
            >
              <Icon icon="mdi:eye-off" />
              Hidden Items ({hiddenFeedPosts.length})
            </button>
          {/if}
        {/if}
        <button
          onclick={loadFeeds}
          class="px-3 py-1.5 text-sm bg-transparent hover:bg-base-100 dark:hover:bg-base-800 rounded-md transition-colors"
          disabled={loading}
        >
          <Icon
            icon={loading ? "mdi:loading" : "mdi:refresh"}
            class={loading ? "animate-spin" : ""}
          />
          Refresh
        </button>
      </div>
    </div>
  </div>

  <!-- Scrollable content area -->
  <div class="flex-1 overflow-y-auto p-6 space-y-6" bind:this={scrollContainer}>
    {#if loading}
      <div class="flex items-center justify-center py-8">
        <Icon icon="mdi:loading" class="animate-spin size-6 text-primary" />
        <span class="ml-2">
          {showingThread ? "Loading thread..." : "Loading feeds..."}
        </span>
      </div>
    {:else if error}
      <div
        class="flex items-center gap-2 p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg"
      >
        <Icon icon="mdi:alert-circle" class="text-red-600 dark:text-red-400" />
        <span class="text-red-800 dark:text-red-200">{error}</span>
      </div>
    {:else if feedPosts.length === 0 && hiddenFeedPosts.length === 0}
      <div class="text-center py-8 text-base-content/60">
        <Icon
          icon={showingThread ? "mdi:comment-off" : "mdi:rss-off"}
          class="size-12 mx-auto mb-2"
        />
        <p>{showingThread ? "Thread not found" : "No feed posts available"}</p>
        <p class="text-sm mt-2">
          {showingThread
            ? "The thread may have been deleted or you don't have permission to view it"
            : "The configured feeds may not have recent posts"}
        </p>
      </div>
    {:else}
      <div class="space-y-4">
        {#each feedPosts as post (post.uri)}
          <div
            class="bg-white dark:bg-base-800 border border-base-200 dark:border-base-700 rounded-lg shadow-sm transition-all
            {post.isThreadRoot
              ? 'border-l-4 border-l-blue-500 bg-blue-50/50 dark:bg-blue-900/20'
              : post.isReply
                ? 'border-l-2 border-l-base-300 bg-base-50/50 dark:bg-base-700/50'
                : !showingThread
                  ? 'cursor-pointer hover:shadow-md hover:bg-base-50 dark:hover:bg-base-750'
                  : ''}"
            style={post.isReply
              ? `margin-left: ${post.replyDepth * 20}px;`
              : ""}
            onclick={() => {
              if (!post.isThreadRoot && !post.isReply && !showingThread) {
                showThread(post.uri);
              }
            }}
          >
            <div class="p-4">
              <!-- Post Header -->
              <div class="flex items-start justify-between mb-3">
                <div class="flex items-center gap-3">
                  {#if post.author.avatar}
                    <img
                      src={post.author.avatar}
                      alt={post.author.displayName || post.author.handle}
                      class="size-10 rounded-full object-cover"
                    />
                  {:else}
                    <div
                      class="size-10 rounded-full bg-base-300 flex items-center justify-center"
                    >
                      <Icon icon="mdi:account" class="size-6" />
                    </div>
                  {/if}
                  <div class="flex-1 min-w-0">
                    <div class="font-semibold">
                      {post.author.displayName || post.author.handle}
                    </div>
                    <div
                      class="flex items-center gap-2 text-sm text-base-content/60"
                    >
                      <span
                        >@{post.author.handle} • {getRelativeTime(
                          post.record.createdAt,
                        )}</span
                      >
                      {#if post.record.reply}
                        <span
                          class="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-yellow-100 dark:bg-yellow-900/30 text-yellow-800 dark:text-yellow-200 rounded-full"
                        >
                          <Icon icon="mdi:reply" class="size-3" />
                          Reply
                        </span>
                      {/if}
                      {#if post.isThreadRoot}
                        <span
                          class="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-200 rounded-full"
                        >
                          <Icon icon="mdi:message-text" class="size-3" />
                          Original Post
                        </span>
                      {:else if post.isReply}
                        <span
                          class="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-200 rounded-full"
                        >
                          <Icon icon="mdi:reply" class="size-3" />
                          Reply
                        </span>
                      {:else if post.replyCount && post.replyCount > 0}
                        <span
                          class="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-200 rounded-full"
                        >
                          <Icon icon="mdi:comment-multiple" class="size-3" />
                          Thread
                        </span>
                      {/if}
                    </div>
                  </div>
                </div>
                <a
                  href={getFeedUrl(post.feedSource)}
                  target="_blank"
                  rel="noopener"
                  class="inline-flex items-center px-2 py-1 text-xs bg-accent-100 dark:bg-accent-900/30 text-accent-800 dark:text-accent-200 rounded-md hover:bg-accent-200 dark:hover:bg-accent-900/50 transition-colors"
                >
                  {getFeedName(post.feedSource)}
                </a>
              </div>

              <!-- Post Content -->
              <div class="mb-4">
                <p class="whitespace-pre-wrap">{post.record.text}</p>
              </div>

              <!-- Post Images -->
              {#if post.images && post.images.length > 0}
                <div class="mb-4">
                  {#if post.images.length === 1}
                    <img
                      src={post.images[0]}
                      alt="Post image"
                      class="w-full max-w-md rounded-lg object-cover max-h-80"
                      loading="lazy"
                    />
                  {:else}
                    <div
                      class="grid gap-2 {post.images.length === 2
                        ? 'grid-cols-2'
                        : post.images.length === 3
                          ? 'grid-cols-3'
                          : 'grid-cols-2'}"
                    >
                      {#each post.images as image, i}
                        <img
                          src={image}
                          alt="Post image {i + 1}"
                          class="w-full rounded-lg object-cover aspect-square {post
                            .images.length > 4 && i >= 4
                            ? 'hidden'
                            : ''}"
                          loading="lazy"
                        />
                      {/each}
                      {#if post.images.length > 4}
                        <div
                          class="flex items-center justify-center bg-base-300 rounded-lg aspect-square text-sm font-medium"
                        >
                          +{post.images.length - 4} more
                        </div>
                      {/if}
                    </div>
                  {/if}
                </div>
              {/if}

              <!-- Post Footer -->
              <div
                class="flex items-center justify-between text-sm text-base-content/60"
              >
                <div class="flex items-center gap-4">
                  {#if post.replyCount}
                    <span
                      class="flex items-center gap-1 text-blue-600 font-medium"
                    >
                      <Icon icon="mdi:comment-multiple" class="size-4" />
                      {post.replyCount}
                      {post.replyCount === 1 ? "reply" : "replies"}
                    </span>
                  {/if}
                  {#if post.repostCount}
                    <span class="flex items-center gap-1">
                      <Icon icon="mdi:repeat" class="size-4" />
                      {post.repostCount}
                    </span>
                  {/if}
                  {#if post.likeCount}
                    <span class="flex items-center gap-1">
                      <Icon icon="mdi:heart" class="size-4" />
                      {post.likeCount}
                    </span>
                  {/if}
                </div>
                <div class="flex items-center gap-3">
                  <button
                    onclick={(e) => {
                      e.stopPropagation();
                      handleBookmark(post);
                    }}
                    class="text-yellow-600 dark:text-yellow-400 hover:text-yellow-700 dark:hover:text-yellow-300 flex items-center gap-1 transition-colors"
                    title={isPostBookmarked(post)
                      ? "Remove bookmark"
                      : "Bookmark thread"}
                  >
                    <Icon
                      icon={isPostBookmarked(post)
                        ? "mdi:bookmark"
                        : "mdi:bookmark-outline"}
                      class="size-4"
                    />
                    {isPostBookmarked(post) ? "Bookmarked" : "Bookmark"}
                  </button>
                  <button
                    onclick={(e) => {
                      e.stopPropagation();
                      handleHide(post);
                    }}
                    class="text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 flex items-center gap-1 transition-colors"
                    title={atprotoFeedService.isHidden(me.current, post.uri)
                      ? "Unhide thread"
                      : "Hide thread"}
                  >
                    <Icon
                      icon={atprotoFeedService.isHidden(me.current, post.uri)
                        ? "mdi:eye-off"
                        : "mdi:eye-off-outline"}
                      class="size-4"
                    />
                    {atprotoFeedService.isHidden(me.current, post.uri)
                      ? "Unhide"
                      : "Hide"}
                  </button>
                  <a
                    href={getBlueskyUrl(post)}
                    target="_blank"
                    rel="noopener"
                    class="text-accent-600 dark:text-accent-400 hover:text-accent-700 dark:hover:text-accent-300 flex items-center gap-1 hover:underline transition-colors"
                  >
                    <Icon icon="mdi:open-in-new" class="size-4" />
                    View on Bluesky
                  </a>
                </div>
              </div>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>

<BookmarksModal
  show={showBookmarks}
  {bookmarks}
  {objectId}
  onClose={() => {
    showBookmarks = false;
  }}
  onViewThread={handleViewThreadFromBookmarks}
/>

<HiddenItemsModal
  show={showHiddenItems}
  hiddenPosts={hiddenFeedPosts}
  onClose={() => (showHiddenItems = false)}
  onUnhide={handleHide}
/>

<style>
  .line-clamp-2 {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
</style>
