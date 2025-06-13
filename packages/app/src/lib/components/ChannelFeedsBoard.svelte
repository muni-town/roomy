<script lang="ts">
  import { co } from "jazz-tools";
  import { Channel } from "$lib/jazz/schema";
  import {
    ATPROTO_FEED_CONFIG,
    AtprotoFeedAggregator,
    ATPROTO_FEEDS,
  } from "$lib/utils/atproToFeeds";
  import { user } from "$lib/user.svelte";
  import type {
    AtprotoFeedPost,
    AtprotoThreadPost,
  } from "$lib/utils/atproToFeeds";
  import Icon from "@iconify/svelte";
  import { format } from "date-fns";
  import {
    enableAtprotoFeeds,
    createThread,
    createMessage,
  } from "$lib/jazz/utils";
  import { navigate } from "$lib/utils.svelte";
  import { page } from "$app/state";

  let {
    channel,
  }: {
    channel: co.loaded<typeof Channel> | null | undefined;
  } = $props();

  let feedPosts = $state<AtprotoFeedPost[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  let aggregator: AtprotoFeedAggregator | null = null;

  // Initialize aggregator when user agent becomes available
  $effect(() => {
    if (user.agent && !aggregator) {
      aggregator = new AtprotoFeedAggregator(user.agent);
      loadFeeds();
    }
  });

  async function loadFeeds() {
    if (
      !aggregator ||
      !channel?.showAtprotoFeeds ||
      !channel?.atprotoFeedsConfig
    ) {
      return;
    }

    loading = true;
    error = null;

    try {
      const posts = channel.atprotoFeedsConfig.threadsOnly
        ? await aggregator.fetchThreadsOnly(50)
        : await aggregator.fetchAggregatedFeed(50);

      feedPosts = posts;
    } catch (err) {
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
    if (!feedSource || !ATPROTO_FEED_CONFIG[feedSource]) {
      return "🔮 ATProto Feed";
    }
    return ATPROTO_FEED_CONFIG[feedSource].name;
  }

  function getFeedUrl(feedSource?: string): string {
    if (!feedSource || !ATPROTO_FEED_CONFIG[feedSource]) {
      return "#";
    }
    return ATPROTO_FEED_CONFIG[feedSource].url;
  }

  function getBlueskyUrl(post: AtprotoFeedPost): string {
    return post.uri
      .replace("at://", "https://bsky.app/profile/")
      .replace("/app.bsky.feed.post/", "/post/");
  }

  function enableFeeds() {
    if (!channel) return;
    enableAtprotoFeeds(channel, ATPROTO_FEEDS, true);
    loadFeeds();
  }

  async function createFeedThread(post: AtprotoFeedPost) {
    if (!channel || !aggregator) return;

    // Fetch the full thread context
    const fullThread = await aggregator.fetchPostThread(post.uri);

    // Create a thread name from the post
    const threadName =
      post.record.text.length > 50
        ? post.record.text.substring(0, 47) + "..."
        : post.record.text;

    // Create the thread
    const thread = createThread([], channel.id, `💬 ${threadName}`);

    // Function to format a post as HTML with proper depth indentation
    const formatPostAsHtml = (
      threadPost: AtprotoThreadPost,
      isRoot = false,
      depth = 0,
    ) => {
      const authorInfo = `<strong>${threadPost.author.displayName || threadPost.author.handle}</strong> (@${threadPost.author.handle})`;
      const timestamp = new Date(threadPost.record.createdAt).toLocaleString();

      // Calculate indentation based on depth (max 6 levels to prevent excessive nesting)
      const indentLevel = Math.min(depth, 6);
      const marginLeft = indentLevel * 20; // 20px per level
      const borderColor = isRoot
        ? "border-l-blue-500"
        : depth === 1
          ? "border-l-green-400"
          : depth === 2
            ? "border-l-yellow-400"
            : depth === 3
              ? "border-l-purple-400"
              : depth === 4
                ? "border-l-pink-400"
                : depth === 5
                  ? "border-l-orange-400"
                  : "border-l-base-300";

      return `<div class="mb-3 ${isRoot ? "p-3 border-l-4 bg-base-100/50 rounded-r" : "pl-4 border-l-2"} ${borderColor}" style="margin-left: ${marginLeft}px;">
        <div class="mb-2 text-sm opacity-70">
          ${authorInfo} • ${timestamp}
        </div>
        <p class="mb-2">${threadPost.record.text}</p>
        ${
          isRoot
            ? `<hr class="my-4 border-base-300">
        <p class="mb-2"><strong>📡 From:</strong> <a href="${getFeedUrl(post.feedSource)}" target="_blank" rel="noopener" class="link link-primary">${getFeedName(post.feedSource)}</a></p>
        <p class="mb-2"><strong>🔗 View on Bluesky:</strong> <a href="${getBlueskyUrl(post)}" target="_blank" rel="noopener" class="link link-primary">${getBlueskyUrl(post)}</a></p>`
            : ""
        }
      </div>`;
    };

    // Function to recursively format replies with proper nesting
    const formatReplies = (replies: AtprotoThreadPost[], depth = 1): string => {
      return replies
        .map((reply) => {
          const replyHtml = formatPostAsHtml(reply, false, depth);
          const nestedReplies = reply.replies
            ? formatReplies(reply.replies, depth + 1)
            : "";
          return replyHtml + nestedReplies;
        })
        .join("");
    };

    // Create initial message with full thread content
    let messageContent: string;

    if (fullThread && fullThread.replies && fullThread.replies.length > 0) {
      // Include the full thread conversation
      messageContent =
        formatPostAsHtml(fullThread, true, 0) +
        formatReplies(fullThread.replies, 1);
    } else {
      // Fallback to simple post format
      messageContent = `<p class="mb-4">${post.record.text}</p>

<hr class="my-4 border-base-300">

<p class="mb-2"><strong>📡 From:</strong> <a href="${getFeedUrl(post.feedSource)}" target="_blank" rel="noopener" class="link link-primary">${getFeedName(post.feedSource)}</a></p>
${
  post.replyCount || post.repostCount || post.likeCount
    ? `<p class="mb-2"><strong>📊 Stats:</strong> ${[
        post.replyCount ? `${post.replyCount} replies` : "",
        post.repostCount ? `${post.repostCount} reposts` : "",
        post.likeCount ? `${post.likeCount} likes` : "",
      ]
        .filter(Boolean)
        .join(" • ")}</p>`
    : ""
}

<p class="mb-2"><strong>🔗 View on Bluesky:</strong> <a href="${getBlueskyUrl(post)}" target="_blank" rel="noopener" class="link link-primary">${getBlueskyUrl(post)}</a></p>`;
    }

    // Create and add the initial message to the thread
    const message = createMessage(messageContent);
    thread.timeline?.push(message.id);

    // Add thread to channel
    channel.subThreads?.push(thread);

    // Navigate to the new thread
    navigate({
      space: page.params.space!,
      thread: thread.id,
    });
  }
</script>

{#if channel?.showAtprotoFeeds}{:else if channel}
  <div class="dz-card bg-base-200 shadow-sm">
    <div class="dz-card-body p-6 text-center">
      <Icon icon="mdi:rss" class="size-12 mx-auto mb-4 text-blue-500" />
      <h3 class="text-lg font-semibold mb-2">Enable ATProto Feeds</h3>
      <p class="text-base-content/60 mb-4">
        Show the latest posts from ATProto development feeds in this channel's
        board view.
      </p>
      <button onclick={enableFeeds} class="dz-btn dz-btn-primary">
        <Icon icon="mdi:rss" />
        Enable Feeds
      </button>
    </div>
  </div>
{/if}

{#if channel?.showAtprotoFeeds}
  <div class="space-y-6">
    <div class="flex items-center justify-between">
      <h2 class="text-xl font-bold flex items-center gap-2">
        <Icon icon="mdi:rss" class="text-blue-500" />
        Feeds
      </h2>
      <button
        onclick={loadFeeds}
        class="dz-btn dz-btn-sm dz-btn-ghost"
        disabled={loading}
      >
        <Icon
          icon={loading ? "mdi:loading" : "mdi:refresh"}
          class={loading ? "animate-spin" : ""}
        />
        Refresh
      </button>
    </div>

    {#if loading}
      <div class="flex items-center justify-center py-8">
        <Icon icon="mdi:loading" class="animate-spin size-6 text-primary" />
        <span class="ml-2">Loading feeds...</span>
      </div>
    {:else if error}
      <div class="dz-alert dz-alert-error">
        <Icon icon="mdi:alert-circle" />
        <span>{error}</span>
      </div>
    {:else if feedPosts.length === 0}
      <div class="text-center py-8 text-base-content/60">
        <Icon icon="mdi:rss-off" class="size-12 mx-auto mb-2" />
        <p>No feed posts available</p>
      </div>
    {:else}
      <div class="space-y-4">
        {#each feedPosts as post (post.uri)}
          <article
            class="dz-card bg-base-200 shadow-sm hover:shadow-md transition-all cursor-pointer hover:bg-base-300 {post
              .record.reply
              ? 'border-l-4 border-l-orange-400'
              : ''} {post.replyCount && post.replyCount > 0
              ? 'border-r-4 border-r-blue-400'
              : ''}"
            onclick={() => createFeedThread(post)}
            role="button"
            tabindex="0"
            onkeydown={(e) => e.key === "Enter" && createFeedThread(post)}
          >
            <div class="dz-card-body p-4">
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
                  <div>
                    <div class="font-semibold flex items-center gap-2">
                      {post.author.displayName || post.author.handle}
                      {#if post.record.reply}
                        <span class="dz-badge dz-badge-warning dz-badge-xs">
                          <Icon icon="mdi:reply" class="size-3" />
                          Reply
                        </span>
                      {/if}
                      {#if post.replyCount && post.replyCount > 0}
                        <span class="dz-badge dz-badge-info dz-badge-xs">
                          <Icon icon="mdi:comment-multiple" class="size-3" />
                          Thread
                        </span>
                      {/if}
                    </div>
                    <div class="text-sm text-base-content/60">
                      @{post.author.handle} • {getRelativeTime(
                        post.record.createdAt,
                      )}
                    </div>
                  </div>
                </div>
                <a
                  href={getFeedUrl(post.feedSource)}
                  target="_blank"
                  rel="noopener"
                  class="dz-badge dz-badge-primary dz-badge-sm"
                >
                  {getFeedName(post.feedSource)}
                </a>
              </div>

              <!-- Post Content -->
              <div class="mb-4">
                <p class="whitespace-pre-wrap">{post.record.text}</p>
              </div>

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
                  <a
                    href={getBlueskyUrl(post)}
                    target="_blank"
                    rel="noopener"
                    class="dz-link dz-link-primary flex items-center gap-1 hover:underline"
                    onclick={(e) => e.stopPropagation()}
                  >
                    <Icon icon="mdi:open-in-new" class="size-4" />
                    View on Bluesky
                  </a>
                </div>
              </div>
            </div>
          </article>
        {/each}
      </div>
    {/if}
  </div>
{/if}
