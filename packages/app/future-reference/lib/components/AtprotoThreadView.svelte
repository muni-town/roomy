<script lang="ts">
  import { Thread, Message } from "@roomy-chat/sdk";
  import { AtprotoFeedAggregator } from "$lib/utils/atproToFeeds";
  import type { AtprotoThreadPost } from "$lib/utils/atproToFeeds";
  import { user } from "$lib/user.svelte";
  import Icon from "@iconify/svelte";
  import { page } from "$app/state";
  import { CoState } from "jazz-svelte";
  import { goto } from "$app/navigation";

  let {
    threadId,
  }: {
    threadId: string;
  } = $props();

  let thread = $derived(new CoState(Thread, threadId));
  let firstMessage = $derived(
    thread.current?.timeline?.perAccount
      ? Object.values(thread.current.timeline.perAccount)
          .map((accountFeed) => new Array(...accountFeed.all))
          .flat()
          .sort((a, b) => a.madeAt.getTime() - b.madeAt.getTime())
          .map((a) => a.value)?.[0]
      : null,
  );

  let message = $derived(new CoState(Message, firstMessage || ""));

  let aggregator: AtprotoFeedAggregator | null = null;
  let threadData = $state<AtprotoThreadPost | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);

  // Initialize aggregator when user agent and session become available
  $effect(() => {
    if (user.agent && user.session && !aggregator) {
      console.log("Creating aggregator with session:", user.session.did);
      // Ensure the agent has the session
      if (!user.agent.session) {
        console.log("Agent missing session, re-setting it");
        user.agent.session = user.session;
      }
      aggregator = new AtprotoFeedAggregator(user.agent);
    }
  });

  // Extract ATProto URI from message content
  $effect(() => {
    if (message.current?.content && aggregator) {
      extractAndLoadThread(message.current.content);
    }
  });

  async function extractAndLoadThread(content: string) {
    if (!aggregator) return;

    // Look for Bluesky URL in the content
    const blueskyUrlMatch = content.match(
      /https:\/\/bsky\.app\/profile\/[^\/]+\/post\/([^<\s"]+)/,
    );
    if (blueskyUrlMatch) {
      const postId = blueskyUrlMatch[1];
      // Convert back to AT URI format
      const authorMatch = content.match(
        /https:\/\/bsky\.app\/profile\/([^\/]+)\/post/,
      );
      if (authorMatch) {
        const author = authorMatch[1];
        const atUri = `at://${author}/app.bsky.feed.post/${postId}`;

        loading = true;
        error = null;

        try {
          const thread = await aggregator.fetchPostThread(atUri);
          threadData = thread;
        } catch (err) {
          error = "Failed to load thread";
          console.error("Thread loading error:", err);
        } finally {
          loading = false;
        }
      }
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

  function getBlueskyUrl(post: AtprotoThreadPost): string {
    return post.uri
      .replace("at://", "https://bsky.app/profile/")
      .replace("/app.bsky.feed.post/", "/post/");
  }

  async function likePost(post: AtprotoThreadPost) {
    console.log("likePost called:", {
      hasAggregator: !!aggregator,
      hasSession: !!user.session,
      sessionDid: user.session?.did,
      agentSessionDid: user.agent?.session?.did,
    });

    if (!aggregator || !user.session) {
      // Prompt user to login
      user.isLoginDialogOpen = true;
      return;
    }
    const success = await aggregator.likePost(post.uri, post.cid);
    if (success) {
      // Optimistically update the UI
      post.likeCount = (post.likeCount || 0) + 1;
    }
  }

  async function repostPost(post: AtprotoThreadPost) {
    if (!aggregator || !user.session) {
      // Prompt user to login
      user.isLoginDialogOpen = true;
      return;
    }
    const success = await aggregator.repostPost(post.uri, post.cid);
    if (success) {
      // Optimistically update the UI
      post.repostCount = (post.repostCount || 0) + 1;
    }
  }

  let replyText = $state("");
  let replyingTo = $state<string | null>(null);

  async function replyToPost(
    post: AtprotoThreadPost,
    rootPost?: AtprotoThreadPost,
  ) {
    if (!aggregator || !replyText.trim()) return;

    const success = await aggregator.replyToPost(
      post.uri,
      post.cid,
      replyText,
      rootPost?.uri,
      rootPost?.cid,
    );
    if (success) {
      replyText = "";
      replyingTo = null;
      // Refresh the thread to show new reply
      if (threadData) {
        const refreshed = await aggregator.fetchPostThread(threadData.uri);
        if (refreshed) threadData = refreshed;
      }
    }
  }
</script>

<div class="flex flex-col h-full overflow-hidden">
  <!-- Header similar to TimelineView -->
  <div
    class="flex-none bg-base-50 border-b border-base-400/30 dark:border-base-300/10 p-4"
  >
    <button
      class="btn btn-ghost btn-sm flex items-center gap-2 hover:bg-base-200"
      onclick={() => {
        const channelId = thread.current?.channelId;
        if (channelId) {
          goto(`/${page.params.space}/${channelId}#board`);
        }
      }}
    >
      <Icon icon="mdi:arrow-left" class="size-5" />
      Back to Feeds
    </button>
  </div>

  <!-- Scrollable content -->
  <div class="flex-1 overflow-y-auto bg-base-100">
    <div class="container mx-auto max-w-4xl p-6">
      {#if loading}
        <div class="flex items-center justify-center py-12">
          <Icon
            icon="mdi:loading"
            class="animate-spin size-8 text-primary mr-3"
          />
          <span class="text-lg">Loading thread...</span>
        </div>
      {:else if error}
        <div class="alert alert-error">
          <Icon icon="mdi:alert-circle" />
          <span>{error}</span>
        </div>
      {:else if threadData}
        <!-- Root Post -->
        <div class="mb-8">
          <article class="dz-card bg-base-100 shadow-lg">
            <div class="dz-card-body p-6">
              <!-- Author Info -->
              <div class="flex items-center gap-4 mb-4">
                {#if threadData.author.avatar}
                  <img
                    src={threadData.author.avatar}
                    alt={threadData.author.displayName ||
                      threadData.author.handle}
                    class="size-12 rounded-full object-cover"
                  />
                {:else}
                  <div
                    class="size-12 rounded-full bg-base-300 flex items-center justify-center"
                  >
                    <Icon icon="mdi:account" class="size-8" />
                  </div>
                {/if}
                <div>
                  <div class="font-bold text-lg">
                    {threadData.author.displayName || threadData.author.handle}
                  </div>
                  <div class="text-sm opacity-70">
                    @{threadData.author.handle} • {getRelativeTime(
                      threadData.record.createdAt,
                    )}
                  </div>
                </div>
              </div>

              <!-- Post Content -->
              <div class="prose prose-sm max-w-none mb-6">
                <p class="text-lg leading-relaxed whitespace-pre-wrap">
                  {threadData.record.text}
                </p>
              </div>

              <!-- Post Images -->
              {#if threadData.images && threadData.images.length > 0}
                <div class="mb-6">
                  {#if threadData.images.length === 1}
                    <img
                      src={threadData.images[0]}
                      alt="Post image"
                      class="w-full max-w-2xl rounded-lg object-cover max-h-96"
                      loading="lazy"
                    />
                  {:else}
                    <div
                      class="grid gap-3 max-w-2xl {threadData.images.length ===
                      2
                        ? 'grid-cols-2'
                        : threadData.images.length === 3
                          ? 'grid-cols-3'
                          : 'grid-cols-2'}"
                    >
                      {#each threadData.images as image, i}
                        <img
                          src={image}
                          alt="Post image {i + 1}"
                          class="w-full rounded-lg object-cover aspect-square {threadData
                            .images.length > 4 && i >= 4
                            ? 'hidden'
                            : ''}"
                          loading="lazy"
                        />
                      {/each}
                      {#if threadData.images.length > 4}
                        <div
                          class="flex items-center justify-center bg-base-300 rounded-lg aspect-square text-sm font-medium"
                        >
                          +{threadData.images.length - 4} more
                        </div>
                      {/if}
                    </div>
                  {/if}
                </div>
              {/if}

              <!-- Post Actions -->
              <div
                class="flex items-center gap-6 pt-4 border-t border-base-300"
              >
                <button
                  class="dz-btn dz-btn-ghost dz-btn-sm flex items-center gap-2 hover:text-red-500"
                  onclick={() => likePost(threadData!)}
                >
                  <Icon icon="mdi:heart" class="size-5" />
                  <span>{threadData.likeCount || 0}</span>
                </button>

                <button
                  class="dz-btn dz-btn-ghost dz-btn-sm flex items-center gap-2 hover:text-green-500"
                  onclick={() => repostPost(threadData!)}
                >
                  <Icon icon="mdi:repeat" class="size-5" />
                  <span>{threadData.repostCount || 0}</span>
                </button>

                <button
                  class="dz-btn dz-btn-ghost dz-btn-sm flex items-center gap-2 hover:text-blue-500"
                  onclick={() => (replyingTo = threadData!.uri)}
                >
                  <Icon icon="mdi:reply" class="size-5" />
                  <span>{threadData.replyCount || 0}</span>
                </button>

                <a
                  href={getBlueskyUrl(threadData)}
                  target="_blank"
                  rel="noopener"
                  class="dz-btn dz-btn-ghost dz-btn-sm flex items-center gap-2"
                >
                  <Icon icon="mdi:open-in-new" class="size-5" />
                  View on Bluesky
                </a>
              </div>

              <!-- Reply Form -->
              {#if replyingTo === threadData.uri}
                <div class="mt-4 pt-4 border-t border-base-300">
                  <div class="flex gap-3">
                    <textarea
                      bind:value={replyText}
                      placeholder="Write a reply..."
                      class="dz-textarea dz-textarea-bordered flex-1"
                      rows="3"
                    ></textarea>
                  </div>
                  <div class="flex gap-2 mt-3">
                    <button
                      class="dz-btn dz-btn-primary dz-btn-sm"
                      onclick={() => replyToPost(threadData!, threadData!)}
                      disabled={!replyText.trim()}
                    >
                      Reply
                    </button>
                    <button
                      class="dz-btn dz-btn-ghost dz-btn-sm"
                      onclick={() => {
                        replyingTo = null;
                        replyText = "";
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              {/if}
            </div>
          </article>
        </div>

        <!-- Replies -->
        {#if threadData.replies && threadData.replies.length > 0}
          <div class="space-y-4">
            <h2 class="text-xl font-semibold mb-4 flex items-center gap-2">
              <Icon icon="mdi:comment-multiple" class="text-blue-500" />
              Replies ({threadData.replies.length})
            </h2>

            {#each threadData.replies as reply, index (reply.uri)}
              {@const depth = 0}
              {@render replyComponent(reply, depth, threadData)}
            {/each}
          </div>
        {/if}
      {:else}
        <div class="text-center py-12 opacity-70">
          <Icon icon="mdi:forum-outline" class="size-16 mx-auto mb-4" />
          <p>No thread data available</p>
        </div>
      {/if}
    </div>
  </div>
</div>

{#snippet replyComponent(
  reply: AtprotoThreadPost,
  depth: number,
  rootPost: AtprotoThreadPost,
)}
  <div style="margin-left: {depth > 0 ? 20 : 0}px">
    <article class="dz-card bg-base-200 shadow-sm border-l-2 border-l-blue-400">
      <div class="dz-card-body p-4">
        <!-- Author Info -->
        <div class="flex items-center gap-3 mb-3">
          {#if reply.author.avatar}
            <img
              src={reply.author.avatar}
              alt={reply.author.displayName || reply.author.handle}
              class="size-8 rounded-full object-cover"
            />
          {:else}
            <div
              class="size-8 rounded-full bg-base-300 flex items-center justify-center"
            >
              <Icon icon="mdi:account" class="size-5" />
            </div>
          {/if}
          <div>
            <div class="font-semibold text-sm">
              {reply.author.displayName || reply.author.handle}
            </div>
            <div class="text-xs opacity-70">
              @{reply.author.handle} • {getRelativeTime(reply.record.createdAt)}
            </div>
          </div>
        </div>

        <!-- Reply Content -->
        <div class="mb-3">
          <p class="text-sm leading-relaxed whitespace-pre-wrap">
            {reply.record.text}
          </p>
        </div>

        <!-- Reply Images -->
        {#if reply.images && reply.images.length > 0}
          <div class="mb-3">
            {#if reply.images.length === 1}
              <img
                src={reply.images[0]}
                alt="Reply image"
                class="w-full max-w-md rounded-lg object-cover max-h-64"
                loading="lazy"
              />
            {:else}
              <div
                class="grid gap-2 max-w-md {reply.images.length === 2
                  ? 'grid-cols-2'
                  : reply.images.length === 3
                    ? 'grid-cols-3'
                    : 'grid-cols-2'}"
              >
                {#each reply.images as image, i}
                  <img
                    src={image}
                    alt="Reply image {i + 1}"
                    class="w-full rounded-lg object-cover aspect-square {reply
                      .images.length > 4 && i >= 4
                      ? 'hidden'
                      : ''}"
                    loading="lazy"
                  />
                {/each}
                {#if reply.images.length > 4}
                  <div
                    class="flex items-center justify-center bg-base-300 rounded-lg aspect-square text-xs font-medium"
                  >
                    +{reply.images.length - 4}
                  </div>
                {/if}
              </div>
            {/if}
          </div>
        {/if}

        <!-- Reply Actions -->
        <div class="flex items-center gap-4 text-xs">
          <button
            class="dz-btn dz-btn-ghost dz-btn-xs flex items-center gap-1 hover:text-red-500"
            onclick={() => likePost(reply)}
          >
            <Icon icon="mdi:heart-outline" class="size-4" />
            <span>{reply.likeCount || 0}</span>
          </button>

          <button
            class="dz-btn dz-btn-ghost dz-btn-xs flex items-center gap-1 hover:text-green-500"
            onclick={() => repostPost(reply)}
          >
            <Icon icon="mdi:repeat" class="size-4" />
            <span>{reply.repostCount || 0}</span>
          </button>

          <button
            class="dz-btn dz-btn-ghost dz-btn-xs flex items-center gap-1 hover:text-blue-500"
            onclick={() => (replyingTo = reply.uri)}
          >
            <Icon icon="mdi:reply" class="size-4" />
          </button>
        </div>

        <!-- Reply Form for this comment -->
        {#if replyingTo === reply.uri}
          <div class="mt-3 pt-3 border-t border-base-300">
            <div class="flex gap-2">
              <textarea
                bind:value={replyText}
                placeholder="Write a reply..."
                class="dz-textarea dz-textarea-bordered dz-textarea-sm flex-1"
                rows="2"
              ></textarea>
            </div>
            <div class="flex gap-2 mt-2">
              <button
                class="dz-btn dz-btn-primary dz-btn-xs"
                onclick={() => replyToPost(reply, rootPost)}
                disabled={!replyText.trim()}
              >
                Reply
              </button>
              <button
                class="dz-btn dz-btn-ghost dz-btn-xs"
                onclick={() => {
                  replyingTo = null;
                  replyText = "";
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        {/if}
      </div>
    </article>

    <!-- Nested replies -->
    {#if reply.replies && reply.replies.length > 0}
      <div class="mt-3 space-y-3">
        {#each reply.replies as nestedReply (nestedReply.uri)}
          {@render replyComponent(nestedReply, depth + 1, rootPost)}
        {/each}
      </div>
    {/if}
  </div>
{/snippet}
