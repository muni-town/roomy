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
  let feedNameUpdateTrigger = $state(0); // Force reactivity when feed names update

  let aggregator: AtprotoFeedAggregator | null = null;

  // Initialize aggregator when user agent and session become available
  $effect(() => {
    if (user.agent && user.session && !aggregator) {
      // Ensure the agent has the session
      if (!user.agent.session) {
        user.agent.session = user.session;
      }
      aggregator = new AtprotoFeedAggregator(user.agent);
    }
  });

  // Load feeds when channel changes or aggregator becomes available
  $effect(() => {
    if (aggregator && channel) {
      console.log("ChannelFeedsBoard - Channel loaded:", {
        channelType: channel.channelType,
        showAtprotoFeeds: channel.showAtprotoFeeds,
        atprotoFeedsConfig: channel.atprotoFeedsConfig,
        configuredFeeds: channel.atprotoFeedsConfig?.feeds,
      });
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
      const configuredFeeds = channel.atprotoFeedsConfig.feeds;

      // If no feeds are configured, don't load anything
      if (!configuredFeeds || configuredFeeds.length === 0) {
        feedPosts = [];
        return;
      }

      const posts = channel.atprotoFeedsConfig.threadsOnly
        ? await aggregator.fetchThreadsOnly(50, configuredFeeds)
        : await aggregator.fetchAggregatedFeed(50, configuredFeeds);

      feedPosts = posts;

      // Register callbacks for feed name updates to trigger reactivity
      const uniqueFeedSources = [
        ...new Set(posts.map((post) => post.feedSource).filter(Boolean)),
      ];
      uniqueFeedSources.forEach((feedSource) => {
        if (feedSource && !ATPROTO_FEED_CONFIG[feedSource]) {
          aggregator.onFeedNameUpdate(feedSource, () => {
            feedNameUpdateTrigger++; // Trigger reactivity
          });
        }
      });
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
    if (!feedSource) {
      return "🔮 ATProto Feed";
    }

    // Access the trigger to ensure reactivity when names update
    feedNameUpdateTrigger;

    // Use the aggregator's cached feed names
    if (aggregator) {
      return aggregator.getCachedFeedName(feedSource);
    }

    // Check if it's one of our predefined feeds
    if (ATPROTO_FEED_CONFIG[feedSource]) {
      return ATPROTO_FEED_CONFIG[feedSource].name;
    }

    // Final fallback for custom feeds
    return "📡 Custom Feed";
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

  function enableFeeds() {
    if (!channel) return;
    enableAtprotoFeeds(channel, ATPROTO_FEEDS, true);
    loadFeeds();
  }

  async function createFeedThread(post: AtprotoFeedPost) {
    if (!channel || !aggregator) return;

    // Check if a thread already exists for this post
    const postUrl = getBlueskyUrl(post);
    
    // Check existing threads by looking at their names - threads created from feeds have specific naming pattern
    const threadNameToCheck = post.record.text.length > 50
      ? post.record.text.substring(0, 47) + "..."
      : post.record.text;
    
    const existingThread = channel.subThreads?.find(thread => {
      if (!thread || thread.softDeleted) return false;
      
      // Check if thread name matches the pattern we would create
      const expectedName = `💬 ${threadNameToCheck}`;
      return thread.name === expectedName;
    });

    if (existingThread) {
      // Navigate to existing thread instead of creating a new one
      navigate({
        space: page.params.space!,
        thread: existingThread.id,
      });
      return;
    }

    // Fetch the full thread context
    const fullThread = await aggregator.fetchPostThread(post.uri);

    // Create a thread name from the post
    const threadName =
      post.record.text.length > 50
        ? post.record.text.substring(0, 47) + "..."
        : post.record.text;

    // Create the thread
    const thread = createThread([], channel.id, `💬 ${threadName}`);

    // Get feed name synchronously for HTML generation
    const feedName = getFeedName(post.feedSource);

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
          threadPost.images && threadPost.images.length > 0
            ? `<div class="mb-2">${threadPost.images
                .map(
                  (img) =>
                    `<img src="${img}" alt="Post image" class="max-w-full h-auto rounded-lg mb-2" style="max-height: 300px; object-fit: contain;" />`,
                )
                .join("")}</div>`
            : ""
        }
        ${
          isRoot
            ? `<hr class="my-4 border-base-300">
        <p class="mb-2"><strong>📡 From:</strong> <a href="${getFeedUrl(post.feedSource)}" target="_blank" rel="noopener" class="link link-primary">${feedName}</a></p>
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

${
  post.images && post.images.length > 0
    ? `<div class="mb-4">${post.images
        .map(
          (img) =>
            `<img src="${img}" alt="Post image" class="max-w-full h-auto rounded-lg mb-2" style="max-height: 300px; object-fit: contain;" />`,
        )
        .join("")}</div>`
    : ""
}

<hr class="my-4 border-base-300">

<p class="mb-2"><strong>📡 From:</strong> <a href="${getFeedUrl(post.feedSource)}" target="_blank" rel="noopener" class="link link-primary">${feedName}</a></p>
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

{#if channel?.channelType === "feeds" && channel?.showAtprotoFeeds}
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
        {#if !channel?.atprotoFeedsConfig?.feeds || channel.atprotoFeedsConfig.feeds.length === 0}
          <p>No feeds configured for this channel</p>
          <p class="text-sm mt-2">
            Add feeds in channel settings to see posts here
          </p>
        {:else}
          <p>No feed posts available</p>
          <p class="text-sm mt-2">
            The configured feeds may not have recent posts
          </p>
        {/if}
      </div>
    {:else}
      <div class="space-y-4">
        {#each feedPosts as post (post.uri)}
          <div
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
                    <div class="grid gap-2 {post.images.length === 2 ? 'grid-cols-2' : post.images.length === 3 ? 'grid-cols-3' : 'grid-cols-2'}">
                      {#each post.images as image, i}
                        <img
                          src={image}
                          alt="Post image {i + 1}"
                          class="w-full rounded-lg object-cover aspect-square {post.images.length > 4 && i >= 4 ? 'hidden' : ''}"
                          loading="lazy"
                        />
                      {/each}
                      {#if post.images.length > 4}
                        <div class="flex items-center justify-center bg-base-300 rounded-lg aspect-square text-sm font-medium">
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
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}
