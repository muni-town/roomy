import {
  AtprotoFeedAggregator,
  type AtprotoFeedPost,
  ATPROTO_FEEDS,
  ATPROTO_FEED_CONFIG,
} from "$lib/utils/atproToFeeds";
import { user } from "$lib/user.svelte";
import { createMessage, RoomyObject, Message, ThreadContent } from "@roomy-chat/sdk";
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

  async populateThread(roomyObject: co.loaded<typeof RoomyObject>): Promise<void> {
    console.log(
      "🔄 Starting ATProto feed population for thread:",
      roomyObject.name,
    );

    this.checkAgent();
    if (!this.aggregator) {
      console.error("❌ No ATProto aggregator available - user not logged in?");
      return;
    }

    // Check if this is a feeds thread by looking for feed configuration in components
    if (!roomyObject.components?.feedConfig) {
      console.log("⚠️ Thread is not configured for ATProto feeds");
      return;
    }

    try {
      console.log("📡 Fetching posts from ATProto feeds...");
      
      // Parse feed configuration from components
      const feedConfig = JSON.parse(roomyObject.components.feedConfig);
      
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

      // Get existing messages to avoid duplicates
      const threadContent = await ThreadContent.load(roomyObject.components.thread);
      const timeline = threadContent?.timeline;
      if (!timeline) {
        console.error("❌ No timeline found for thread");
        return;
      }

      console.log(`🔍 Checking existing messages in timeline...`);
      console.log("Timeline object:", timeline);
      console.log("Timeline type:", typeof timeline);
      console.log("Timeline constructor:", timeline.constructor.name);
      console.log("Timeline length:", timeline?.length);

      const existingMessages = new Set<string>();

      // Handle different timeline structures
      try {
        if (timeline && typeof timeline[Symbol.iterator] === "function") {
          console.log("✅ Timeline is iterable");
          let count = 0;
          for (const messageId of timeline) {
            count++;
            if (count > 100) break; // Safety limit
            try {
              const message = await Message.load(messageId);
              if (message?.author && message.author.startsWith("atproto")) {
                // Extract original post URI from author field (format: atproto||handle||displayName||did||uri||avatar)
                const parts = message.author.split("||");
                if (parts.length >= 5) {
                  const originalUri = parts[4]; // URI is at index 4
                  if (originalUri) {
                    existingMessages.add(originalUri);
                  }
                }
              }
            } catch (error) {
              // Ignore load errors for now
            }
          }
          console.log(`🔍 Checked ${count} messages in timeline`);
        } else if (timeline && Array.isArray(timeline)) {
          console.log("✅ Timeline is an array");
          for (const messageId of timeline) {
            try {
              const message = await Message.load(messageId);
              if (message?.author && message.author.startsWith("atproto")) {
                // Extract original post URI from author field (format: atproto||handle||displayName||did||uri||avatar)
                const parts = message.author.split("||");
                if (parts.length >= 5) {
                  const originalUri = parts[4]; // URI is at index 4
                  if (originalUri) {
                    existingMessages.add(originalUri);
                  }
                }
              }
            } catch (error) {
              // Ignore load errors for now
            }
          }
        } else {
          console.log("⚠️ Timeline is not iterable, treating as empty");
        }
      } catch (error) {
        console.error("❌ Error iterating timeline:", error);
      }

      console.log(
        `📋 Found ${existingMessages.size} existing ATProto messages`,
      );

      // Add new posts as messages (newest first)
      let addedCount = 0;
      const newMessages: string[] = [];

      for (const post of posts) {
        if (!existingMessages.has(post.uri)) {
          try {
            const message = this.createMessageFromPost(post);
            newMessages.push(message.id);
            addedCount++;
          } catch (error) {
            console.error(
              `❌ Failed to add post from ${post.author.handle}:`,
              error,
            );
          }
        }
      }

      // Add new messages to timeline (newest first)
      if (newMessages.length > 0) {
        if (typeof timeline.unshift === "function") {
          newMessages.reverse().forEach((id) => timeline.unshift(id));
          console.log(`✅ Added ${newMessages.length} messages (newest first)`);
        } else if (typeof timeline.splice === "function") {
          timeline.splice(0, 0, ...newMessages.reverse());
          console.log(`✅ Added ${newMessages.length} messages (newest first)`);
        } else if (typeof timeline.push === "function") {
          newMessages.reverse().forEach((id) => timeline.push(id));
          console.log(
            `⚠️ Added ${newMessages.length} messages (newest at bottom)`,
          );
        } else {
          console.error("❌ Timeline has no add methods available");
        }
      }

      console.log(`✅ Added ${addedCount} new messages to channel`);
    } catch (error) {
      console.error("❌ Failed to populate ATProto feed channel:", error);
    }
  }

  private createMessageFromPost(
    post: AtprotoFeedPost,
  ): co.loaded<typeof Message> {
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
      post.author.did,
      post.uri, // Store URI for deduplication
      post.author.avatar ? encodeURIComponent(post.author.avatar) : "", // Encode avatar URL
    ].join("||");

    message.author = authorInfo;

    // Use original post creation time for both created and updated
    const postDate = new Date(post.record.createdAt);
    message.createdAt = postDate;
    message.updatedAt = postDate; // Same as created to avoid "edited" indicator

    return message;
  }

  startAutoUpdate(feedThreads: co.loaded<typeof RoomyObject>[]): void {
    if (this.isRunning) return;

    this.isRunning = true;
    this.intervalId = setInterval(async () => {
      for (const thread of feedThreads) {
        if (thread?.components?.feedConfig) {
          await this.populateThread(thread);
        }
      }
    }, this.UPDATE_INTERVAL);

    // Initial population
    setTimeout(async () => {
      for (const thread of feedThreads) {
        if (thread?.components?.feedConfig) {
          await this.populateThread(thread);
        }
      }
    }, 1000); // Small delay to ensure everything is loaded
  }

  stopAutoUpdate(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
  }

  async manualRefresh(roomyObject: co.loaded<typeof RoomyObject>): Promise<void> {
    if (this.aggregator) {
      this.aggregator.clearCache();
      await this.populateThread(roomyObject);
    }
  }

  // Fix existing ATProto messages to have proper avatar URLs
  async fixExistingMessageAvatars(
    roomyObject: co.loaded<typeof RoomyObject>,
  ): Promise<void> {
    console.log("🔧 Fixing existing ATProto message avatars...");

    const threadContent = await ThreadContent.load(roomyObject.components.thread);
    const timeline = threadContent?.timeline;
    if (!timeline) {
      console.error("❌ No timeline found");
      return;
    }

    let fixedCount = 0;

    try {
      if (timeline && typeof timeline[Symbol.iterator] === "function") {
        for (const messageId of timeline) {
          try {
            const message = await Message.load(messageId);
            if (message?.author && message.author.startsWith("atproto")) {
              const parts = message.author.split("||");
              if (parts.length >= 6) {
                const [prefix, handle, displayName, did, uri, avatarBlob] =
                  parts;

                // If avatar is just a blob reference, construct proper URL
                if (avatarBlob && !avatarBlob.startsWith("http")) {
                  const properAvatarUrl = `https://cdn.bsky.app/img/avatar/plain/${did}/${avatarBlob}@jpeg`;
                  const newAuthorInfo = [
                    prefix,
                    handle,
                    displayName,
                    did,
                    uri,
                    encodeURIComponent(properAvatarUrl),
                  ].join("||");

                  message.author = newAuthorInfo;
                  fixedCount++;

                  console.log(
                    `✅ Fixed avatar for ${handle}: ${avatarBlob} -> ${properAvatarUrl}`,
                  );
                }
              }
            }
          } catch (error) {
            // Ignore individual message errors
          }
        }
      }
    } catch (error) {
      console.error("❌ Error fixing avatars:", error);
    }

    console.log(`🎉 Fixed ${fixedCount} message avatars`);
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

  (window as any).fixExistingAvatars = async (channelId?: string) => {
    console.log("🔧 Fixing avatars in existing ATProto messages...");

    if (!channelId) {
      console.log("ℹ️ Usage: fixExistingAvatars('channel-id')");
      console.log(
        "ℹ️ Or find channel ID in the URL when viewing an ATProto channel",
      );
      return;
    }

    try {
      const roomyObject = await RoomyObject.load(channelId);
      if (!roomyObject) {
        console.error("❌ Thread not found");
        return;
      }

      if (!roomyObject.components?.feedConfig) {
        console.error("❌ This is not an ATProto feed thread");
        return;
      }

      await atprotoFeedService.fixExistingMessageAvatars(roomyObject);
    } catch (error) {
      console.error("❌ Error:", error);
    }
  };

  (window as any).refreshAtprotoThread = async (
    threadName = "atproto-feeds",
  ) => {
    console.log(`🔄 Manually refreshing ATProto thread: ${threadName}`);
    const service = atprotoFeedService;
    service.checkAgent();
    if (service.aggregator) {
      // Clear cache first
      service.aggregator.clearCache();
      console.log("🗑️ Cache cleared, forcing fresh fetch...");
    }
    return "Run this in a space with an ATProto thread to test";
  };
}
