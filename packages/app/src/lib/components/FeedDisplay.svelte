<script lang="ts">
  import { co, z } from "jazz-tools";
  import {
    RoomyEntity,
    RoomyAccount,
    createMessage,
    createThread,
    publicGroup,
    isSpaceAdmin,
    IDList,
    SpacePermissionsComponent,
  } from "@roomy-chat/sdk";
  import { AccountCoState, CoState } from "jazz-tools/svelte";
  import {
    ATPROTO_FEED_CONFIG,
    AtprotoFeedAggregator,
    ATPROTO_FEEDS,
    type AtprotoThreadPost,
  } from "$lib/utils/atproToFeeds";
  import { user } from "$lib/user.svelte";
  import type { AtprotoFeedPost } from "$lib/utils/atproToFeeds";
  import Icon from "@iconify/svelte";
  import { navigate } from "$lib/utils.svelte";
  import { page } from "$app/state";

  let {
    thread,
  }: {
    thread: co.loaded<typeof RoomyEntity> | null | undefined;
  } = $props();

  let feedPosts = $state<AtprotoFeedPost[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let feedNameUpdateTrigger = $state(0); // Force reactivity when feed names update

  let aggregator: AtprotoFeedAggregator | null = null;

  // Get the current space for admin check
  let space = $derived(new CoState(RoomyEntity, page.params.space));

  // Get space permissions for thread creation
  let permissions = $derived(
    new CoState(
      SpacePermissionsComponent.schema,
      space.current?.components?.[SpacePermissionsComponent.id],
    ),
  );

  // Get the current Jazz account
  const me = new AccountCoState(RoomyAccount, {
    resolve: {
      profile: true,
      root: true,
    },
  });

  // Track which dropdown is open (by post URI)
  let openDropdown = $state<string | null>(null);

  // Track hidden posts panel for non-admin users
  let showHiddenPanel = $state(false);

  // Get user's hidden posts with details
  let userHiddenPosts = $state<
    Array<{ uri: string; preview: string; author: string; hiddenAt: Date }>
  >([]);

  // Update hidden posts when account data changes (optimized)
  $effect(() => {
    try {
      if (!me.current?.profile?.hiddenFeedPosts) {
        userHiddenPosts = [];
        return;
      }

      const personallyHidden = me.current.profile.hiddenFeedPosts || [];
      const hiddenCache = me.current.profile.hiddenFeedPostsCache || [];

      const result = personallyHidden.map((uri) => {
        const cached = hiddenCache.find((c) => c?.uri === uri);
        return {
          uri,
          preview: cached?.text || `Post ${uri.split("/").pop()?.slice(-8)}`,
          author: cached?.author || extractAuthorFromUri(uri),
          hiddenAt: cached?.hiddenAt || new Date(),
        };
      });

      userHiddenPosts = result;
    } catch (error) {
      userHiddenPosts = [];
    }
  });

  function extractAuthorFromUri(uri: string): string {
    // Extract author DID from AT Proto URI: at://did:plc:xyz/app.bsky.feed.post/postid
    try {
      const match = uri.match(/^at:\/\/([^\/]+)/);
      if (match) {
        const did = match[1];
        // Convert DID to a more readable format
        if (did.startsWith("did:plc:")) {
          return `@${did.replace("did:plc:", "").slice(0, 12)}...`;
        }
        return `@${did.slice(0, 20)}...`;
      }
    } catch (e) {
      // Ignore parsing errors
    }
    return "Unknown author";
  }

  function unhideUserPost(postUri: string) {
    if (!me.current?.profile?.hiddenFeedPosts) return;

    // Remove from personal hidden list
    const hiddenPosts = me.current.profile.hiddenFeedPosts;
    const newList = [];
    for (let i = 0; i < hiddenPosts.length; i++) {
      if (hiddenPosts[i] !== postUri) {
        newList.push(hiddenPosts[i]);
      }
    }
    hiddenPosts.splice(0, hiddenPosts.length, ...newList);

    // Also remove from cached data
    if (me.current.profile.hiddenFeedPostsCache) {
      const index = me.current.profile.hiddenFeedPostsCache.findIndex(
        (cached) => cached && cached.uri === postUri,
      );
      if (index !== -1) {
        me.current.profile.hiddenFeedPostsCache.splice(index, 1);
      }
    }

    console.log("✅ Post unhidden by user");
  }

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

  // Load feeds when thread changes or aggregator becomes available
  $effect(() => {
    if (aggregator && thread) {
      console.log("FeedDisplay - Thread loaded:", {
        threadName: thread.name,
        feedConfig: thread.components?.feedConfig,
      });
      loadFeeds();
    }
  });

  async function loadFeeds() {
    if (!aggregator || !thread?.components?.feedConfig) {
      return;
    }

    loading = true;
    error = null;

    try {
      const feedConfig = JSON.parse(thread.components.feedConfig);
      const configuredFeeds = feedConfig.feeds;

      // Handle single post feed threads (feed thread discussions)
      if (feedConfig.singlePost) {
        // Load the specific post thread for this feed thread
        const postThread = await aggregator.fetchPostThread(
          feedConfig.singlePost.uri,
        );
        if (postThread) {
          // Convert the entire thread to feed post format for display
          const threadPosts = [];

          // Add the main post
          const mainPost = {
            uri: feedConfig.singlePost.uri,
            cid: postThread.cid || "",
            author: {
              did: postThread.author?.did || "",
              handle: postThread.author?.handle || feedConfig.singlePost.author,
              displayName:
                postThread.author?.displayName || feedConfig.singlePost.author,
              avatar: postThread.author?.avatar || "",
            },
            record: {
              text: postThread.record?.text || feedConfig.singlePost.text,
              createdAt:
                postThread.record?.createdAt || new Date().toISOString(),
            },
            replyCount: postThread.replies?.length || 0,
            repostCount: postThread.repostCount || 0,
            likeCount: postThread.likeCount || 0,
            indexedAt: postThread.indexedAt || new Date().toISOString(),
            feedSource: "thread-root",
            images: postThread.images || [],
            isThreadRoot: true, // Mark as the root post
          };
          threadPosts.push(mainPost);

          // Add all replies as separate posts, maintaining proper nesting order
          if (postThread.replies && postThread.replies.length > 0) {
            const flattenReplies = (replies, depth = 1) => {
              replies.forEach((reply) => {
                // Add the current reply
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

                // Immediately add nested replies after this reply (depth-first traversal)
                if (reply.replies && reply.replies.length > 0) {
                  flattenReplies(reply.replies, depth + 1);
                }
              });
            };

            flattenReplies(postThread.replies);
          }

          feedPosts = threadPosts;
        } else {
          feedPosts = [];
        }
        return;
      }

      // If no feeds are configured, don't load anything
      if (!configuredFeeds || configuredFeeds.length === 0) {
        feedPosts = [];
        return;
      }

      const posts = feedConfig.threadsOnly
        ? await aggregator.fetchThreadsOnly(50, configuredFeeds)
        : await aggregator.fetchAggregatedFeed(50, configuredFeeds);

      // Filter out hidden posts (both personal and globally hidden)
      const personallyHidden = me.current?.profile?.hiddenFeedPosts || [];
      const globallyHidden = thread.components?.globalHiddenPosts
        ? JSON.parse(thread.components.globalHiddenPosts)
            .filter((ghp: any) => ghp && ghp.isHidden)
            .map((ghp: any) => ghp.postUri)
        : [];

      const allHiddenUris = [...personallyHidden, ...globallyHidden];
      feedPosts = posts.filter((post) => !allHiddenUris.includes(post.uri));

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

  async function createFeedThread(post: AtprotoFeedPost) {
    if (!thread || !aggregator || !space?.current) return;

    // Check if feed thread creation is supported in current structure
    try {
      // Create a thread name from the post
      const threadName =
        post.record.text.length > 50
          ? post.record.text.substring(0, 47) + "..."
          : post.record.text;

      // Create the child thread using permissions (like other parts of the app)
      if (!permissions.current) {
        console.error("Could not load space permissions");
        return;
      }

      // Create a feed thread instead of a regular thread
      const newFeedThread = await createThread(`💬 ${threadName}`, permissions.current);

      // Convert it to a feed thread by removing thread component and adding feedConfig
      delete newFeedThread.roomyObject.components.thread;

      // Create a simple feed config for this feed thread (single post thread)
      const feedConfig = {
        feeds: [], // Empty feeds array since this is a feed thread discussion
        threadsOnly: false,
        enabled: false, // Disabled feed aggregation for feed thread discussions
        singlePost: {
          uri: post.uri,
          author: post.author.handle,
          text: post.record.text,
        },
      };

      newFeedThread.roomyObject.components.feedConfig =
        JSON.stringify(feedConfig);

      // Add feed threads to root folder so they appear as top-level items
      const rootFolderChildren = space.current?.rootFolder?.components?.children;
      if (rootFolderChildren) {
        const childrenList = await IDList.load(rootFolderChildren);
        if (childrenList) {
          childrenList.push(newFeedThread.roomyObject.id);
          console.log("🔍 SUCCESS: Added feed thread to root folder (top-level)", {
            threadId: newFeedThread.roomyObject.id,
            threadName: newFeedThread.roomyObject.name,
            rootFolderChildrenCount: childrenList.length
          });
        }
      }

      // Add to space threads (for completeness)
      space.current.threads?.push(newFeedThread.roomyObject);

      // Brief delay to ensure changes are committed
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Navigate to the new feed thread
      navigate({
        space: page.params.space!,
        object: newFeedThread.roomyObject.id,
      });
    } catch (error) {
      console.error("Failed to create feed thread:", error);
    }
  }

  function hidePostPersonally(post: AtprotoFeedPost) {
    console.log("🔍 Hide button clicked for post:", post.uri);
    
    if (!me.current?.profile) {
      console.error("❌ Cannot hide post: No user profile available");
      return;
    }

    console.log("🔍 Current profile state:", {
      hasHiddenFeedPosts: !!me.current.profile.hiddenFeedPosts,
      hasHiddenFeedPostsCache: !!me.current.profile.hiddenFeedPostsCache,
    });

    try {
      // Initialize hiddenFeedPosts if it doesn't exist (fallback for existing profiles)
      if (!me.current.profile.hiddenFeedPosts) {
        console.log("⚠️ Initializing hiddenFeedPosts for existing profile");
        me.current.profile.hiddenFeedPosts = co
          .list(z.string())
          .create([], publicGroup("writer"));
      }

      // Initialize hiddenFeedPostsCache if it doesn't exist (fallback for existing profiles)
      if (!me.current.profile.hiddenFeedPostsCache) {
        console.log("⚠️ Initializing hiddenFeedPostsCache for existing profile");
        me.current.profile.hiddenFeedPostsCache = co
          .list(co.map({
            uri: z.string(),
            text: z.string(),
            author: z.string(),
            hiddenAt: z.date(),
          }))
          .create([], publicGroup("writer"));
      }

      // Store post data for better UI display
      const postData = co.map({
        uri: z.string(),
        text: z.string(),
        author: z.string(),
        hiddenAt: z.date(),
      }).create({
        uri: post.uri,
        text: post.record.text.slice(0, 100),
        author: post.author.displayName || post.author.handle,
        hiddenAt: new Date(),
      }, publicGroup("reader"));

      console.log("🔍 Adding to hidden lists:", postData);
      
      me.current.profile.hiddenFeedPostsCache.push(postData);
      me.current.profile.hiddenFeedPosts.push(post.uri);

      // Remove from display
      const originalLength = feedPosts.length;
      feedPosts = feedPosts.filter((p) => p.uri !== post.uri);
      
      console.log(`✅ Post hidden successfully. Removed ${originalLength - feedPosts.length} posts from display`);
      console.log("🔍 Hidden posts count:", me.current.profile.hiddenFeedPosts.length);
      
    } catch (error) {
      console.error("❌ Error hiding post personally:", error);
      console.error("❌ Error details:", {
        message: error.message,
        stack: error.stack,
        postUri: post.uri,
      });
    }
  }
</script>

{#if thread?.components?.feedConfig}
  <div class="flex-1 flex flex-col h-full overflow-hidden">
    <div
      class="flex-shrink-0 p-6 border-b border-base-300 dark:border-base-700"
    >
      <div class="flex items-center justify-between">
        <h2 class="text-xl font-bold flex items-center gap-2">
          <Icon icon="mdi:rss" class="text-blue-500" />
          Feed Items
        </h2>
        <div class="flex items-center gap-2">
          <!-- Show hidden posts button for all users -->
          <button
            onclick={() => {
              console.log("🔘 Show Hidden button clicked", {
                showHiddenPanel,
                userHiddenPostsLength: userHiddenPosts.length,
                isSpaceAdmin: isSpaceAdmin(space.current),
                hasSpace: !!space.current,
              });
              showHiddenPanel = !showHiddenPanel;
            }}
            class="px-3 py-1.5 text-sm border border-base-300 dark:border-base-700 rounded-md hover:bg-base-100 dark:hover:bg-base-800 transition-colors"
            title="View your hidden posts"
          >
            <Icon icon="mdi:eye-off" class="size-4" />
            {showHiddenPanel ? "Hide" : "Show"} Hidden
            {#if userHiddenPosts.length > 0}({userHiddenPosts.length}){/if}
          </button>
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
    <div class="flex-1 overflow-y-auto p-6 space-y-6">
      <!-- Hidden Posts Panel -->
      {#if showHiddenPanel}
        <div class="bg-base-200 dark:bg-base-800 rounded-lg p-4 border border-base-300 dark:border-base-700">
          <div class="flex items-center justify-between mb-3">
            <h3 class="text-lg font-semibold flex items-center gap-2">
              <Icon icon="mdi:eye-off" class="size-5" />
              Your Hidden Posts
            </h3>
            <button
              onclick={() => (showHiddenPanel = false)}
              class="p-1 hover:bg-base-300 dark:hover:bg-base-600 rounded transition-colors"
            >
              <Icon icon="mdi:close" class="size-4" />
            </button>
          </div>

          {#if userHiddenPosts.length === 0}
            <p class="text-sm text-base-content/60">
              You haven't hidden any posts yet.
            </p>
          {:else}
            <p class="text-xs text-base-content/60 mb-3">
              Showing all your hidden posts across all feed channels
            </p>
            <div class="space-y-2 max-h-64 overflow-y-auto">
              {#each userHiddenPosts as hiddenPost}
                <div
                  class="flex items-center justify-between gap-3 p-3 bg-base-100 dark:bg-base-700 rounded"
                >
                  <div class="flex-1 min-w-0">
                    <div class="text-sm text-base-content/80 truncate">
                      {hiddenPost.preview}
                    </div>
                    <div class="text-xs text-base-content/60">
                      {hiddenPost.author} • Hidden {new Date(
                        hiddenPost.hiddenAt,
                      ).toLocaleDateString()}
                    </div>
                  </div>
                  <button
                    onclick={() => unhideUserPost(hiddenPost.uri)}
                    class="px-2 py-1 text-xs text-accent-600 dark:text-accent-400 hover:bg-accent-50 dark:hover:bg-accent-900/20 rounded transition-colors"
                    title="Unhide this post"
                  >
                    <Icon icon="mdi:eye" class="size-4" />
                    Unhide
                  </button>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/if}

      {#if loading}
        <div class="flex items-center justify-center py-8">
          <Icon icon="mdi:loading" class="animate-spin size-6 text-primary" />
          <span class="ml-2">Loading feeds...</span>
        </div>
      {:else if error}
        <div
          class="flex items-center gap-2 p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg"
        >
          <Icon
            icon="mdi:alert-circle"
            class="text-red-600 dark:text-red-400"
          />
          <span class="text-red-800 dark:text-red-200">{error}</span>
        </div>
      {:else if feedPosts.length === 0}
        <div class="text-center py-8 text-base-content/60">
          <Icon icon="mdi:rss-off" class="size-12 mx-auto mb-2" />
          <p>No feed posts available</p>
          <p class="text-sm mt-2">
            The configured feeds may not have recent posts
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
                  : 'cursor-pointer hover:shadow-md hover:bg-base-50 dark:hover:bg-base-750'}"
              style={post.isReply
                ? `margin-left: ${post.replyDepth * 20}px;`
                : ""}
              onclick={!post.isThreadRoot && !post.isReply
                ? () => createFeedThread(post)
                : undefined}
              role={!post.isThreadRoot && !post.isReply ? "button" : undefined}
              tabindex={!post.isThreadRoot && !post.isReply ? "0" : undefined}
              onkeydown={!post.isThreadRoot && !post.isReply
                ? (e) => e.key === "Enter" && createFeedThread(post)
                : undefined}
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
                    <!-- Hide button -->
                    <button
                      class="px-2 py-1 text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded transition-colors flex items-center gap-1"
                      onclick={(e) => {
                        e.stopPropagation();
                        hidePostPersonally(post);
                      }}
                      title="Hide this post"
                    >
                      <Icon icon="mdi:eye-off" class="size-4" />
                      Hide
                    </button>
                    <a
                      href={getBlueskyUrl(post)}
                      target="_blank"
                      rel="noopener"
                      class="text-accent-600 dark:text-accent-400 hover:text-accent-700 dark:hover:text-accent-300 flex items-center gap-1 hover:underline transition-colors"
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
  </div>
{/if}