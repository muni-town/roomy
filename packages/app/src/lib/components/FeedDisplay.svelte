<script lang="ts">
  import { co, z } from "jazz-tools";
  import {
    RoomyObject,
    RoomyAccount,
    Space,
    createMessage,
    createThread,
    publicGroup,
    isSpaceAdmin,
    IDList,
  } from "@roomy-chat/sdk";
  import { Group } from "jazz-tools";
  import { AccountCoState } from "jazz-svelte";
  import {
    ATPROTO_FEED_CONFIG,
    AtprotoFeedAggregator,
    ATPROTO_FEEDS,
    type AtprotoThreadPost,
  } from "$lib/utils/atproToFeeds";
  import { user } from "$lib/user.svelte";
  import type { AtprotoFeedPost } from "$lib/utils/atproToFeeds";
  import Icon from "@iconify/svelte";
  import { CoState } from "jazz-svelte";
  import { navigate } from "$lib/utils.svelte";
  import { page } from "$app/state";

  let {
    thread,
  }: {
    thread: co.loaded<typeof RoomyObject> | null | undefined;
  } = $props();

  let feedPosts = $state<AtprotoFeedPost[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let feedNameUpdateTrigger = $state(0); // Force reactivity when feed names update

  let aggregator: AtprotoFeedAggregator | null = null;

  // Get the current space for admin check
  let space = $derived(new CoState(Space, page.params.space));

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

  // Removed debug effect that was causing performance issues

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

  function initializeGlobalVotingSystem() {
    console.log("🔧 DEBUG: initializeGlobalVotingSystem called", {
      hasThread: !!thread,
      threadId: thread?.id,
      userId: me.current?.id,
      canUserWriteToThread: me.current ? me.current.canWrite(thread) : false,
    });

    if (!thread) {
      console.log("❌ DEBUG: No thread, cannot initialize");
      return;
    }

    try {
      console.log(
        "🚀 DEBUG: Auto-initializing global voting system for channel",
      );

      // For now, skip global voting system initialization for feed threads
      // This would need to be implemented differently for the new schema
      console.log(
        "⚠️ DEBUG: Global voting system not implemented for feed threads yet",
      );

      console.log("✅ DEBUG: Global voting system created");

      // Skip migration for now
      console.log("🎉 DEBUG: Global voting system initialized successfully");
    } catch (error) {
      console.log(
        "⚠️ DEBUG: Could not auto-initialize global voting system:",
        error,
        {
          errorMessage: error.message,
          stack: error.stack,
          errorName: error.name,
        },
      );
      // This is fine - it just means we need admin permissions
    }
  }

  function migratePersonalHidesToGlobal() {
    console.log(
      "🔄 DEBUG: migratePersonalHidesToGlobal skipped for feed threads",
    );
    return;
  }

  // Load feeds when thread changes or aggregator becomes available
  $effect(() => {
    if (aggregator && thread) {
      console.log("ChannelFeedsBoard - Thread loaded:", {
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

  function enableFeeds() {
    if (!thread) return;
    // For threads, feeds are already enabled via feedConfig
    loadFeeds();
  }

  async function createFeedThread(post: AtprotoFeedPost) {
    if (!thread || !aggregator || !space?.current) return;

    // Check if a child thread already exists for this post
    const postUrl = getBlueskyUrl(post);
    const threadNameToCheck =
      post.record.text.length > 50
        ? post.record.text.substring(0, 47) + "..."
        : post.record.text;

    // Temporarily disable checking existing child threads to prevent crashes
    let existingThread = null;
    // TODO: Re-enable once we fix the data structure issues

    if (existingThread) {
      // Navigate to existing thread instead of creating a new one
      navigate({
        space: page.params.space!,
        object: existingThread.id,
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

    // Create the child thread
    const adminGroup = await Group.load(space.current.adminGroupId);
    if (!adminGroup) {
      console.error("Could not load admin group");
      return;
    }

    // Create a feed thread instead of a regular thread
    const newFeedThread = createThread(`💬 ${threadName}`, adminGroup);

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

    // Simple approach: Add feed threads to root folder so they appear as top-level items
    // This avoids all the Jazz co.feed issues and IndexedDB transaction problems
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

    // Add to space threads (for completeness, even though co.feed is broken)
    space.current.threads?.push(newFeedThread.roomyObject);

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

      const marginLeft = 0;
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

    // Function to recursively format replies with consistent indentation
    const formatReplies = (replies: AtprotoThreadPost[]): string => {
      return replies
        .map((reply) => {
          const replyHtml = formatPostAsHtml(reply, false, 1);
          const nestedReplies = reply.replies
            ? formatReplies(reply.replies)
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
        formatReplies(fullThread.replies);
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

    // Feed threads don't need initial messages since they display the post content directly

    // Brief delay to ensure changes are committed
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Navigate to the new feed thread
    navigate({
      space: page.params.space!,
      object: newFeedThread.roomyObject.id,
    });
  }

  function hidePost(post: AtprotoFeedPost) {
    if (!me.current?.profile || !thread) {
      return;
    }

    try {
      // Initialize hiddenFeedPosts if it doesn't exist
      if (!me.current.profile.hiddenFeedPosts) {
        me.current.profile.hiddenFeedPosts = co
          .list(z.string())
          .create([], publicGroup("writer"));
      }

      // Initialize hiddenFeedPostsCache if it doesn't exist
      if (!me.current.profile.hiddenFeedPostsCache) {
        me.current.profile.hiddenFeedPostsCache = co
          .list(
            co.map({
              uri: z.string(),
              text: z.string(),
              author: z.string(),
              hiddenAt: z.date(),
            }),
          )
          .create([], publicGroup("writer"));
      }

      // Store post data for better UI display
      const postData = co
        .map({
          uri: z.string(),
          text: z.string(),
          author: z.string(),
          hiddenAt: z.date(),
        })
        .create(
          {
            uri: post.uri,
            text: post.record.text.slice(0, 100), // First 100 characters
            author: post.author.displayName || post.author.handle,
            hiddenAt: new Date(),
          },
          publicGroup("reader"),
        );

      me.current.profile.hiddenFeedPostsCache.push(postData);

      // Add the post URI to the personal hidden list
      me.current.profile.hiddenFeedPosts.push(post.uri);
      console.log("✅ DEBUG: Added to personal hidden list", {
        uri: post.uri,
        totalPersonalHidden: me.current.profile.hiddenFeedPosts.length,
      });

      // Skip global voting for now in feed threads
      console.log(
        "⚠️ DEBUG: Global voting not implemented for feed threads yet",
      );

      // Remove the post from the current feed display
      feedPosts = feedPosts.filter((p) => p.uri !== post.uri);
    } catch (error) {
      console.error("❌ DEBUG: Error hiding post:", error);
    }
  }

  function hidePostPersonally(post: AtprotoFeedPost) {
    if (!me.current?.profile) return;

    try {
      // Initialize hiddenFeedPosts if it doesn't exist
      if (!me.current.profile.hiddenFeedPosts) {
        me.current.profile.hiddenFeedPosts = co
          .list(z.string())
          .create([], publicGroup("writer"));
      }

      // Initialize hiddenFeedPostsCache if it doesn't exist
      if (!me.current.profile.hiddenFeedPostsCache) {
        me.current.profile.hiddenFeedPostsCache = co
          .list(
            co.map({
              uri: z.string(),
              text: z.string(),
              author: z.string(),
              hiddenAt: z.date(),
            }),
          )
          .create([], publicGroup("writer"));
      }

      // Store post data for better UI display
      const postData = co
        .map({
          uri: z.string(),
          text: z.string(),
          author: z.string(),
          hiddenAt: z.date(),
        })
        .create(
          {
            uri: post.uri,
            text: post.record.text.slice(0, 100),
            author: post.author.displayName || post.author.handle,
            hiddenAt: new Date(),
          },
          publicGroup("reader"),
        );

      me.current.profile.hiddenFeedPostsCache.push(postData);
      me.current.profile.hiddenFeedPosts.push(post.uri);

      // Remove from display
      feedPosts = feedPosts.filter((p) => p.uri !== post.uri);

      console.log("✅ Personal hide completed");
    } catch (error) {
      console.error("❌ Error hiding post personally:", error);
    }
  }

  function hidePostGlobally(post: AtprotoFeedPost) {
    console.log("⚠️ DEBUG: Global hide not implemented for feed threads yet");
    return;

    try {
      // Find existing global hidden post entry or create new one
      let globalPost = channel.globalHiddenPosts.find(
        (ghp) => ghp.postUri === post.uri,
      );

      if (!globalPost) {
        // Create new global hidden post entry with admin override
        globalPost = GlobalHiddenPost.create(
          {
            postUri: post.uri,
            votes: co.list(FeedPostVote).create([], publicGroup("reader")),
            threshold: 1, // Admin override needs only 1 "vote"
            isHidden: true, // Immediately hidden
            hiddenAt: new Date(),
          },
          publicGroup("reader"),
        );

        channel.globalHiddenPosts.push(globalPost);
      } else {
        // Mark existing post as globally hidden
        globalPost.isHidden = true;
        globalPost.hiddenAt = new Date();
      }

      // Remove from display
      feedPosts = feedPosts.filter((p) => p.uri !== post.uri);

      console.log("✅ Global hide completed");
    } catch (error) {
      console.error("❌ Error hiding post globally:", error);
    }
  }

  function addGlobalHideVote(post: AtprotoFeedPost) {
    console.log("🌐 DEBUG: addGlobalHideVote skipped for feed threads");
    return;

    try {
      // Skip global voting if system isn't initialized - keep it simple
      if (!channel.globalHiddenPosts) {
        console.log(
          "⚠️ DEBUG: Global voting system not initialized - votes will only be personal",
        );
        return;
      }

      console.log(
        "🔍 DEBUG: Checking for existing global post for URI:",
        post.uri,
      );

      // Find existing global hidden post entry or create new one
      let globalPost = channel.globalHiddenPosts.find(
        (ghp) => ghp.postUri === post.uri,
      );

      if (!globalPost) {
        console.log("✨ DEBUG: Creating new global hidden post entry");

        try {
          // Create new global hidden post entry
          const newVote = FeedPostVote.create(
            {
              postUri: post.uri,
              userId: me.current.id,
              reason: "irrelevant", // Could be made configurable
              votedAt: new Date(),
            },
            publicGroup("reader"),
          );

          console.log("📊 DEBUG: Created new vote", {
            postUri: post.uri,
            userId: me.current.id,
            voteId: newVote.id,
          });

          // Try to determine the right permission group for the global post
          let globalPostGroup;
          try {
            globalPostGroup = publicGroup("everyone");
            console.log(
              '🔓 DEBUG: Using "everyone" permission for global post',
            );
          } catch (e) {
            console.log(
              '⚠️ DEBUG: Cannot use "everyone" permission, falling back to "reader"',
            );
            globalPostGroup = publicGroup("reader");
          }

          globalPost = GlobalHiddenPost.create(
            {
              postUri: post.uri,
              votes: co.list(FeedPostVote).create([newVote], globalPostGroup),
              threshold: channel.hideThreshold || 3,
              isHidden: false,
            },
            globalPostGroup,
          );

          console.log("🆕 DEBUG: Created new global post", {
            postUri: post.uri,
            globalPostId: globalPost.id,
            threshold: globalPost.threshold,
            initialVotes: globalPost.votes.length,
          });

          channel.globalHiddenPosts.push(globalPost);
          console.log("✅ DEBUG: Added global post to channel list", {
            totalGlobalPosts: channel.globalHiddenPosts.length,
          });
        } catch (createError) {
          console.error(
            "❌ DEBUG: Failed to create new global post:",
            createError,
            {
              errorMessage: createError.message,
              stack: createError.stack,
            },
          );
          throw createError;
        }
      } else {
        console.log("🔍 DEBUG: Found existing global post", {
          globalPostId: globalPost.id,
          currentVotes: globalPost.votes.length,
          isHidden: globalPost.isHidden,
        });

        // Check if user already voted
        const existingVote = globalPost.votes.find(
          (vote) => vote.userId === me.current!.id,
        );
        if (!existingVote) {
          console.log("➕ DEBUG: Adding new vote to existing global post");

          try {
            // Add new vote
            const newVote = FeedPostVote.create(
              {
                postUri: post.uri,
                userId: me.current.id,
                reason: "irrelevant",
                votedAt: new Date(),
              },
              publicGroup("reader"),
            );

            globalPost.votes.push(newVote);
            console.log("✅ DEBUG: Added vote to existing global post", {
              newVoteId: newVote.id,
              totalVotes: globalPost.votes.length,
            });
          } catch (voteError) {
            console.error(
              "❌ DEBUG: Failed to add vote to existing global post:",
              voteError,
              {
                errorMessage: voteError.message,
                stack: voteError.stack,
              },
            );
            throw voteError;
          }
        } else {
          console.log("⚠️ DEBUG: User already voted for this post", {
            existingVoteId: existingVote.id,
            votedAt: existingVote.votedAt,
          });
        }
      }

      // Check if post should be globally hidden
      const voteCount = globalPost.votes.length;
      const threshold = globalPost.threshold;

      console.log("🎯 DEBUG: Checking threshold", {
        voteCount,
        threshold,
        isCurrentlyHidden: globalPost.isHidden,
        shouldHide: voteCount >= threshold && !globalPost.isHidden,
      });

      if (voteCount >= threshold && !globalPost.isHidden) {
        globalPost.isHidden = true;
        globalPost.hiddenAt = new Date();
        console.log(
          `🚫 DEBUG: Post globally hidden with ${voteCount} votes (threshold: ${threshold})`,
        );
      }
    } catch (error) {
      console.error("❌ DEBUG: Error adding global hide vote:", error, {
        stack: error.stack,
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
              console.log("🔘 DEBUG: Show Hidden button clicked", {
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
      <!-- Hidden Posts Panel for Non-Admin Users -->
      {#if showHiddenPanel}
        <div class="bg-base-200 rounded-lg p-4 border border-base-300">
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
                  class="flex items-center justify-between gap-3 p-3 bg-base-100 rounded"
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
                    class="px-2 py-1 text-xs text-accent-600 hover:bg-accent-50 dark:hover:bg-accent-900/20 rounded transition-colors"
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
                    <!-- Simplified hide button for now -->
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
