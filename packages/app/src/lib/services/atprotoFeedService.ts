import {
  AtprotoFeedAggregator,
  type AtprotoFeedPost,
  ATPROTO_FEEDS,
  ATPROTO_FEED_CONFIG,
} from "$lib/utils/atproToFeeds";
import { user } from "$lib/user.svelte";
import { createMessage, RoomyEntity } from "@roomy-chat/sdk";
import { co } from "jazz-tools";

export class AtprotoFeedService {
  private aggregator: AtprotoFeedAggregator | null = null;
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;
  private readonly UPDATE_INTERVAL = 5 * 60 * 1000; // 5 minutes

  constructor() {
    // Initialize aggregator when user agent becomes available
    this.checkAgent();
  }

  private checkAgent() {
    if (user.agent && !this.aggregator) {
      this.aggregator = new AtprotoFeedAggregator(user.agent);
    }
  }

  async populateThread(roomyEntity: co.loaded<typeof RoomyEntity>): Promise<void> {
    console.log(
      "🔄 Starting ATProto feed population for thread:",
      roomyEntity.name,
    );

    this.checkAgent();
    if (!this.aggregator) {
      console.error("❌ No ATProto aggregator available - user not logged in?");
      return;
    }

    // Check if this is a feeds thread by looking for feed configuration in components
    if (!roomyEntity.components?.feedConfig) {
      console.log("⚠️ Thread is not configured for ATProto feeds");
      return;
    }

    try {
      console.log("📡 Fetching posts from ATProto feeds...");
      
      // Parse feed configuration from components
      const feedConfig = JSON.parse(roomyEntity.components.feedConfig);
      
      if (!feedConfig.enabled || !feedConfig.feeds || feedConfig.feeds.length === 0) {
        console.log("⚠️ Feed is disabled or has no configured feeds");
        return;
      }

      const posts = feedConfig.threadsOnly
        ? await this.aggregator.fetchThreadsOnly(50, feedConfig.feeds)
        : await this.aggregator.fetchAggregatedFeed(50, feedConfig.feeds);

      console.log(
        `📊 Fetched ${posts.length} posts from feeds (threads only: ${feedConfig.threadsOnly})`,
      );

      if (posts.length > 0) {
        console.log("📝 Sample post:", {
          text: posts[0].record.text.substring(0, 100) + "...",
          author: posts[0].author.handle,
          isThread: !!(posts[0].record.reply || posts[0].replyCount),
        });
      }

      // For feed threads, we don't populate messages automatically
      // Instead, we let the FeedDisplay component handle the display
      console.log("✅ Feed thread ready for display");
      
    } catch (error) {
      console.error("❌ Failed to populate ATProto feed thread:", error);
    }
  }

  private createMessageFromPost(
    post: AtprotoFeedPost,
  ) {
    // Format the message content with HTML for proper formatting
    let content = `<p>${post.record.text}</p>`;

    // Add feed source with link
    if (post.feedSource && ATPROTO_FEED_CONFIG[post.feedSource]) {
      const feedConfig = ATPROTO_FEED_CONFIG[post.feedSource];
      content += `<p style="margin: 8px 0;"><strong>📡 From:</strong> <a href="${feedConfig.url}" target="_blank" rel="noopener">${feedConfig.name}</a></p>`;
    } else {
      content += `<p style="margin: 8px 0;"><strong>📡 From:</strong> 🔮 ATProto Feed</p>`;
    }

    // Add engagement stats if available
    const stats: string[] = [];
    if (post.replyCount) stats.push(`${post.replyCount} replies`);
    if (post.repostCount) stats.push(`${post.repostCount} reposts`);
    if (post.likeCount) stats.push(`${post.likeCount} likes`);

    if (stats.length > 0) {
      content += `<p style="margin: 8px 0;"><strong>📊 Stats:</strong> ${stats.join(" • ")}</p>`;
    }

    // Add Bluesky link as proper HTML link
    const postUrl = post.uri
      .replace("at://", "https://bsky.app/profile/")
      .replace("/app.bsky.feed.post/", "/post/");
    content += `<p style="margin: 8px 0;"><strong>🔗 View on Bluesky:</strong> <a href="${postUrl}" target="_blank" rel="noopener">${postUrl}</a></p>`;

    const message = createMessage(
      content,
      undefined, // not a reply in our system
      undefined, // no special admin permissions
      undefined, // no embeds for now
    );

    // Use ATProto author info - format: "atproto||handle||displayName||did||uri||avatar"
    // Using || delimiter to avoid conflicts with colons in DIDs
    const authorInfo = [
      "atproto",
      post.author.handle,
      post.author.displayName || post.author.handle,
      post.author.did || "",
      post.uri, // Store URI for deduplication
      post.author.avatar ? encodeURIComponent(post.author.avatar) : "", // Encode avatar URL
    ].join("||");

    message.roomyObject.author = authorInfo;

    // Use original post creation time for both created and updated
    const postDate = new Date(post.record.createdAt);
    message.roomyObject.createdAt = postDate;
    message.roomyObject.updatedAt = postDate; // Same as created to avoid "edited" indicator

    return message.roomyObject;
  }

  async manualRefresh(roomyEntity: co.loaded<typeof RoomyEntity>): Promise<void> {
    if (this.aggregator) {
      this.aggregator.clearCache();
      await this.populateThread(roomyEntity);
    }
  }

  // Check if a thread is configured for feeds
  isThreadConfiguredForFeeds(roomyEntity: co.loaded<typeof RoomyEntity>): boolean {
    if (!roomyEntity.components?.feedConfig) {
      return false;
    }

    try {
      const feedConfig = JSON.parse(roomyEntity.components.feedConfig);
      return feedConfig.enabled && feedConfig.feeds && feedConfig.feeds.length > 0;
    } catch {
      return false;
    }
  }

  // Get feed configuration for a thread
  getFeedConfig(roomyEntity: co.loaded<typeof RoomyEntity>) {
    if (!roomyEntity.components?.feedConfig) {
      return null;
    }

    try {
      return JSON.parse(roomyEntity.components.feedConfig);
    } catch {
      return null;
    }
  }
}

// Global service instance
export const atprotoFeedService = new AtprotoFeedService();

// Add to global scope for debugging
if (typeof window !== "undefined") {
  (window as any).testAtprotoFeeds = async () => {
    console.log("🧪 Testing ATProto feed fetching...");
    const service = atprotoFeedService;
    service.checkAgent();
    if (service.aggregator) {
      try {
        // Clear cache to force fresh fetch
        service.aggregator.clearCache();
        const posts = await service.aggregator.fetchAggregatedFeed(10);
        console.log(
          "📊 Test result:",
          posts.map((p) => ({
            author: p.author.handle,
            text: p.record.text.substring(0, 100),
            isThread: !!(p.record.reply || p.replyCount),
            avatar: p.author.avatar,
          })),
        );
        return posts;
      } catch (error) {
        console.error("❌ Test failed:", error);
      }
    } else {
      console.error("❌ No aggregator available");
    }
  };

  (window as any).clearAtprotoCache = () => {
    console.log("🗑️ Clearing ATProto feed cache...");
    const service = atprotoFeedService;
    if (service.aggregator) {
      service.aggregator.clearCache();
      console.log("✅ Cache cleared! Next fetch will get fresh data.");
    } else {
      console.log("⚠️ No aggregator available");
    }
  };
}