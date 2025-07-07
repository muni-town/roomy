<script lang="ts">
  import { co, z } from "jazz-tools";
  import {
    Channel,
    RoomyAccount,
    GlobalHiddenPost,
    FeedPostVote,
    Space,
    enableAtprotoFeeds,
    createThread,
    createMessage,
    publicGroup,
    isSpaceAdmin,
  } from "@roomy-chat/sdk";
  import { AccountCoState } from "jazz-svelte";
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
  import { CoState } from "jazz-svelte";
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

  // Debug account data loading
  $effect(() => {
    console.log("🔍 DEBUG: Account data changed", {
      hasMe: !!me.current,
      meId: me.current?.id,
      hasProfile: !!me.current?.profile,
      hasHiddenFeedPosts: !!me.current?.profile?.hiddenFeedPosts,
      hiddenFeedPostsLength: me.current?.profile?.hiddenFeedPosts?.length || 0,
      hasHiddenFeedPostsCache: !!me.current?.profile?.hiddenFeedPostsCache,
      hiddenFeedPostsCacheLength:
        me.current?.profile?.hiddenFeedPostsCache?.length || 0,
    });
  });

  // Get user's hidden posts with details
  let userHiddenPosts = $state<
    Array<{ uri: string; preview: string; author: string; hiddenAt: Date }>
  >([]);

  // Update hidden posts when account data changes
  $effect(() => {
    try {
      if (!me.current?.profile?.hiddenFeedPosts) {
        console.log("🔍 DEBUG: No hidden posts data available");
        userHiddenPosts = [];
        return;
      }

      const personallyHidden = me.current.profile.hiddenFeedPosts || [];
      const hiddenCache = me.current.profile.hiddenFeedPostsCache || [];

      console.log("🔍 DEBUG: userHiddenPosts effect called", {
        hasMe: !!me.current,
        hasProfile: !!me.current?.profile,
        personallyHiddenLength: personallyHidden.length,
        hiddenCacheLength: hiddenCache.length,
        personallyHidden: personallyHidden.slice(0, 2), // First 2 URIs for debugging
        hiddenCache: hiddenCache
          .map((c) => ({
            uri: c?.uri,
            hasText: !!c?.text,
            hasAuthor: !!c?.author,
          }))
          .slice(0, 2),
      });

      const result = personallyHidden.map((uri) => {
        const cached = hiddenCache.find((c) => c?.uri === uri);
        return {
          uri,
          preview: cached?.text || `Post ${uri.split("/").pop()?.slice(-8)}`,
          author: cached?.author || extractAuthorFromUri(uri),
          hiddenAt: cached?.hiddenAt || new Date(),
        };
      });

      console.log("🔍 DEBUG: userHiddenPosts result", {
        resultLength: result.length,
        firstFewResults: result.slice(0, 3),
      });

      userHiddenPosts = result;
    } catch (error) {
      console.error("❌ DEBUG: userHiddenPosts effect error:", error);
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
      hasChannel: !!channel?.current,
      channelId: channel?.current?.id,
      userId: me.current?.id,
      channelOwnerId: channel?.current?.owner?.id,
      isChannelOwner: channel?.current?.owner?.id === me.current?.id,
      canUserWriteToChannel: me.current
        ? me.current.canWrite(channel?.current)
        : false,
    });

    if (!channel?.current) {
      console.log("❌ DEBUG: No channel.current, cannot initialize");
      return;
    }

    try {
      console.log(
        "🚀 DEBUG: Auto-initializing global voting system for channel",
      );

      // Try with "everyone" permission first
      try {
        channel.current.globalHiddenPosts = co
          .list(GlobalHiddenPost)
          .create([], publicGroup("everyone"));
        console.log('✅ DEBUG: Created with "everyone" permission');
      } catch (everyoneError) {
        console.log(
          '⚠️ DEBUG: Failed with "everyone" permission, trying "reader":',
          everyoneError.message,
        );

        // Fallback to "reader" permission
        try {
          channel.current.globalHiddenPosts = co
            .list(GlobalHiddenPost)
            .create([], publicGroup("reader"));
          console.log('✅ DEBUG: Created with "reader" permission');
        } catch (readerError) {
          console.log(
            '❌ DEBUG: Failed with "reader" permission too:',
            readerError.message,
          );
          throw readerError;
        }
      }

      // Also set default threshold if not set
      if (!channel.current.hideThreshold) {
        channel.current.hideThreshold = 3;
      }

      console.log("✅ DEBUG: Global voting system created", {
        globalHiddenPostsLength: channel.current.globalHiddenPosts.length,
        hideThreshold: channel.current.hideThreshold,
      });

      // Migrate any existing personal hides to global voting system
      migratePersonalHidesToGlobal();

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
    console.log("🔄 DEBUG: migratePersonalHidesToGlobal called", {
      hasGlobalHiddenPosts: !!channel?.current?.globalHiddenPosts,
      hasPersonalHides: !!me.current?.profile?.hiddenFeedPosts,
      personalHidesLength: me.current?.profile?.hiddenFeedPosts?.length || 0,
      userId: me.current?.id,
    });

    if (
      !channel?.current?.globalHiddenPosts ||
      !me.current?.profile?.hiddenFeedPosts
    ) {
      console.log(
        "❌ DEBUG: Migration skipped - missing global system or personal hides",
      );
      return;
    }

    try {
      const personalHides = me.current.profile.hiddenFeedPosts;
      const uniqueHides = [...new Set(personalHides)]; // Remove duplicates

      console.log(
        `🚀 DEBUG: Migrating ${uniqueHides.length} personal hides to global voting system`,
      );

      uniqueHides.forEach((postUri, index) => {
        console.log(
          `🔄 DEBUG: Migrating post ${index + 1}/${uniqueHides.length}: ${postUri}`,
        );

        // Check if this post already has a global entry
        let globalPost = channel.current!.globalHiddenPosts!.find(
          (ghp) => ghp.postUri === postUri,
        );

        if (!globalPost) {
          console.log("✨ DEBUG: Creating new global entry for migration");

          // Create new global entry with this user's vote
          const newVote = FeedPostVote.create(
            {
              postUri: postUri,
              userId: me.current!.id,
              reason: "migrated", // Mark as migrated from personal hide
              votedAt: new Date(),
            },
            publicGroup("reader"),
          );

          globalPost = GlobalHiddenPost.create(
            {
              postUri: postUri,
              votes: co
                .list(FeedPostVote)
                .create([newVote], publicGroup("everyone")),
              threshold: channel.current!.hideThreshold || 3,
              isHidden: false,
            },
            publicGroup("everyone"),
          );

          channel.current!.globalHiddenPosts!.push(globalPost);
          console.log(
            "✅ DEBUG: Created and added new global post during migration",
            {
              globalPostId: globalPost.id,
              voteId: newVote.id,
            },
          );
        } else {
          console.log(
            "🔍 DEBUG: Found existing global entry, checking for existing vote",
          );

          // Add vote to existing global entry if user hasn't voted yet
          const existingVote = globalPost.votes.find(
            (vote) => vote.userId === me.current!.id,
          );
          if (!existingVote) {
            console.log(
              "➕ DEBUG: Adding migration vote to existing global post",
            );

            const newVote = FeedPostVote.create(
              {
                postUri: postUri,
                userId: me.current!.id,
                reason: "migrated",
                votedAt: new Date(),
              },
              publicGroup("reader"),
            );

            globalPost.votes.push(newVote);
            console.log("✅ DEBUG: Added migration vote", {
              voteId: newVote.id,
            });
          } else {
            console.log(
              "⚠️ DEBUG: User already has vote in global post, skipping",
            );
          }
        }

        // Check if post should be globally hidden after migration
        const voteCount = globalPost.votes.length;
        const threshold = globalPost.threshold;

        console.log("🎯 DEBUG: Checking threshold after migration", {
          postUri,
          voteCount,
          threshold,
          isCurrentlyHidden: globalPost.isHidden,
        });

        if (voteCount >= threshold && !globalPost.isHidden) {
          globalPost.isHidden = true;
          globalPost.hiddenAt = new Date();
          console.log(
            `🚫 DEBUG: Post globally hidden during migration with ${voteCount} votes`,
          );
        }
      });

      console.log("🎉 DEBUG: Personal hides migration completed", {
        totalGlobalPosts: channel.current!.globalHiddenPosts!.length,
      });
    } catch (error) {
      console.error("❌ DEBUG: Error migrating personal hides:", error, {
        stack: error.stack,
      });
    }
  }

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

      // Filter out hidden posts (both personal and globally hidden)
      const personallyHidden = me.current?.profile?.hiddenFeedPosts || [];
      const globallyHidden =
        channel.atprotoFeedsConfig && channel.globalHiddenPosts
          ? channel.globalHiddenPosts
              .filter((ghp) => ghp && ghp.isHidden)
              .map((ghp) => ghp.postUri)
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
    if (!channel) return;
    enableAtprotoFeeds(channel, ATPROTO_FEEDS, true);
    loadFeeds();
  }

  async function createFeedThread(post: AtprotoFeedPost) {
    if (!channel || !aggregator) return;

    // Check if a thread already exists for this post
    const postUrl = getBlueskyUrl(post);

    // Check existing threads by looking at their names - threads created from feeds have specific naming pattern
    const threadNameToCheck =
      post.record.text.length > 50
        ? post.record.text.substring(0, 47) + "..."
        : post.record.text;

    const existingThread = channel.subThreads?.find((thread) => {
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

      // Remove margin-left entirely, use only border and padding for visual hierarchy
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
          const replyHtml = formatPostAsHtml(reply, false, 1); // All replies use depth 1
          const nestedReplies = reply.replies
            ? formatReplies(reply.replies) // Don't increment depth
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

  function hidePost(post: AtprotoFeedPost) {
    console.log("🔍 DEBUG: hidePost called", {
      userId: me.current?.id,
      userProfile: !!me.current?.profile,
      channelProp: !!channel,
      channelCurrent: !!channel?.current,
      channelId: channel?.current?.id,
      channelType: channel?.current?.channelType,
      postUri: post.uri,
      postAuthor: post.author.handle,
      isAdmin: channel?.current?.owner?.id === me.current?.id,
    });

    if (!me.current?.profile || !channel) {
      console.log("❌ DEBUG: hidePost early return - no profile or channel");
      return;
    }

    try {
      // Initialize hiddenFeedPosts if it doesn't exist
      if (!me.current.profile.hiddenFeedPosts) {
        console.log("🔧 DEBUG: Initializing hiddenFeedPosts");
        me.current.profile.hiddenFeedPosts = co
          .list(z.string())
          .create([], publicGroup("writer"));
      }

      // Initialize hiddenFeedPostsCache if it doesn't exist
      if (!me.current.profile.hiddenFeedPostsCache) {
        console.log("🔧 DEBUG: Initializing hiddenFeedPostsCache");
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

      // Global hiding logic for the channel
      if (channel) {
        console.log("🌐 DEBUG: Calling addGlobalHideVote");
        addGlobalHideVote(post);
      } else {
        console.log("❌ DEBUG: No channel, skipping global vote");
      }

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
    if (!channel?.globalHiddenPosts) return;

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
    console.log("🌐 DEBUG: addGlobalHideVote called", {
      userId: me.current?.id,
      channelId: channel?.id,
      postUri: post.uri,
      hasGlobalHiddenPosts: !!channel?.globalHiddenPosts,
      globalHiddenPostsLength: channel?.globalHiddenPosts?.length || 0,
      isAdmin: channel?.owner?.id === me.current?.id,
    });

    if (!channel || !me.current?.id) {
      console.log(
        "❌ DEBUG: addGlobalHideVote early return - no channel or user ID",
      );
      return;
    }

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

{#if channel?.channelType === "feeds" && channel?.showAtprotoFeeds}
  <div class="space-y-6">
    <div class="flex items-center justify-between">
      <h2 class="text-xl font-bold flex items-center gap-2">
        <Icon icon="mdi:rss" class="text-blue-500" />
        Feeds
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
          class="dz-btn dz-btn-sm dz-btn-outline"
          title="View your hidden posts"
        >
          <Icon icon="mdi:eye-off" class="size-4" />
          {showHiddenPanel ? "Hide" : "Show"} Hidden
          {#if userHiddenPosts.length > 0}({userHiddenPosts.length}){/if}
        </button>
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
    </div>

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
            class="dz-btn dz-btn-ghost dz-btn-sm"
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
                  class="dz-btn dz-btn-ghost dz-btn-xs text-primary hover:bg-primary/10"
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
                  {#if channel?.globalHiddenPosts}
                    {#if isSpaceAdmin(space.current)}
                      <!-- Admin with global voting system: custom dropdown -->
                      <div class="relative">
                        <button
                          class="dz-btn dz-btn-ghost dz-btn-xs text-error hover:bg-error/10 flex items-center gap-1"
                          onclick={(e) => {
                            e.stopPropagation();
                            openDropdown =
                              openDropdown === post.uri ? null : post.uri;
                          }}
                          title="Hide this post"
                        >
                          <Icon icon="mdi:eye-off" class="size-4" />
                          Hide
                          <Icon
                            icon={openDropdown === post.uri
                              ? "mdi:chevron-down"
                              : "mdi:chevron-up"}
                            class="size-3"
                          />
                        </button>

                        {#if openDropdown === post.uri}
                          <div
                            class="absolute bottom-full right-0 mb-1 bg-base-200 rounded-box shadow-lg z-10 w-52"
                          >
                            <ul class="menu p-2">
                              <li>
                                <button
                                  onclick={(e) => {
                                    e.stopPropagation();
                                    hidePostPersonally(post);
                                    openDropdown = null;
                                  }}
                                  class="flex items-center gap-2"
                                >
                                  <Icon icon="mdi:account" class="size-4" />
                                  Hide for me only
                                </button>
                              </li>
                              <li>
                                <button
                                  onclick={(e) => {
                                    e.stopPropagation();
                                    hidePostGlobally(post);
                                    openDropdown = null;
                                  }}
                                  class="flex items-center gap-2"
                                >
                                  <Icon icon="mdi:earth" class="size-4" />
                                  Hide globally (admin)
                                </button>
                              </li>
                            </ul>
                          </div>
                        {/if}
                      </div>
                    {:else}
                      <!-- Non-admin with global voting system: regular hide with voting -->
                      <button
                        class="dz-btn dz-btn-ghost dz-btn-xs text-error hover:bg-error/10 flex items-center gap-1"
                        onclick={(e) => {
                          e.stopPropagation();
                          hidePost(post);
                        }}
                        title="Hide this post (adds vote)"
                      >
                        <Icon icon="mdi:eye-off" class="size-4" />
                        Hide
                      </button>
                    {/if}
                  {:else}
                    <!-- No global system: just personal hide -->
                    <button
                      class="dz-btn dz-btn-ghost dz-btn-xs text-error hover:bg-error/10 flex items-center gap-1"
                      onclick={(e) => {
                        e.stopPropagation();
                        hidePost(post);
                      }}
                      title="Hide this post"
                    >
                      <Icon icon="mdi:eye-off" class="size-4" />
                      Hide
                    </button>
                  {/if}
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
