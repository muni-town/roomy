import {
  AtprotoFeedAggregator,
  type AtprotoFeedPost,
  ATPROTO_FEEDS,
  ATPROTO_FEED_CONFIG,
} from "$lib/utils/atproToFeeds";
import { user } from "$lib/user.svelte";
import { RoomyAccount, FeedConfig, FeedAggregatorConfigs, BookmarkedThread, BookmarkedThreads, HiddenThread, HiddenThreads, publicGroup } from "@roomy-chat/sdk";
import { co, z } from "jazz-tools";

export class AtprotoFeedService {
  
  constructor() {
    // No initialization needed for stateless service
  }

  private getAggregator(): AtprotoFeedAggregator | null {
    if (user.agent) {
      return new AtprotoFeedAggregator(user.agent);
    }
    return null;
  }

  getFeedConfig(account: any, objectId: string): { feeds: string[], threadsOnly: boolean } {
    const config = account?.root?.feedConfigs?.[objectId];
    if (config) {
      return {
        feeds: config.feeds || [],
        threadsOnly: config.threadsOnly || false,
      };
    }
    return { feeds: [], threadsOnly: false };
  }

  setFeedConfig(account: any, objectId: string, config: { feeds: string[], threadsOnly: boolean }): void {
    console.log("🔧 setFeedConfig called:", { objectId, config, hasAccount: !!account });
    
    if (!account?.root) {
      console.error("❌ Account root not available");
      return;
    }

    // Initialize feedConfigs if it doesn't exist
    if (!account.root.feedConfigs) {
      console.log("🔧 Initializing feedConfigs in account root");
      try {
        account.root.feedConfigs = FeedAggregatorConfigs.create({}, publicGroup("writer"));
        console.log("✅ Successfully initialized feedConfigs");
      } catch (error) {
        console.error("❌ Failed to initialize feedConfigs:", error);
        return;
      }
    }

    console.log("🔧 Current feedConfigs:", Object.keys(account.root.feedConfigs));

    if (config.feeds.length === 0) {
      // Remove config if no feeds
      console.log("🗑️ Removing config for objectId:", objectId);
      delete account.root.feedConfigs[objectId];
    } else {
      console.log("💾 Setting config for objectId:", objectId, "with", config.feeds.length, "feeds");
      
      // Check if config already exists
      const existingConfig = account.root.feedConfigs[objectId];
      
      if (existingConfig) {
        // Update existing config
        console.log("🔄 Updating existing config");
        
        // Clear existing feeds and add new ones
        existingConfig.feeds.splice(0, existingConfig.feeds.length, ...config.feeds);
        existingConfig.threadsOnly = config.threadsOnly;
      } else {
        // Create new config with proper group permissions
        console.log("✨ Creating new config");
        
        try {
          const feedsList = co.list(z.string()).create(config.feeds, publicGroup("writer"));
          account.root.feedConfigs[objectId] = FeedConfig.create({
            feeds: feedsList,
            threadsOnly: config.threadsOnly,
          }, publicGroup("writer"));
          
          console.log("✅ Successfully created new config");
        } catch (error) {
          console.error("❌ Error creating new config:", error);
        }
      }
    }
    
    console.log("🔧 Final feedConfigs:", Object.keys(account.root.feedConfigs));
  }

  async fetchFeedPosts(feedUris: string[], threadsOnly: boolean = false, limit: number = 50): Promise<AtprotoFeedPost[]> {
    console.log("📡 Fetching posts from ATProto feeds...");

    const aggregator = this.getAggregator();
    if (!aggregator) {
      console.error("❌ No ATProto aggregator available - user not logged in?");
      return [];
    }

    try {
      const posts = threadsOnly
        ? await aggregator.fetchThreadsOnly(limit, feedUris)
        : await aggregator.fetchAggregatedFeed(limit, feedUris);

      console.log(
        `📊 Fetched ${posts.length} posts from feeds (threads only: ${threadsOnly})`,
      );

      return posts;
    } catch (error) {
      console.error("❌ Failed to fetch ATProto feed posts:", error);
      return [];
    }
  }

  async fetchFeedPostsForObject(account: any, objectId: string, limit: number = 50): Promise<AtprotoFeedPost[]> {
    const config = this.getFeedConfig(account, objectId);
    
    if (config.feeds.length === 0) {
      return [];
    }

    return this.fetchFeedPosts(config.feeds, config.threadsOnly, limit);
  }


  async fetchPostThread(postUri: string) {
    const aggregator = this.getAggregator();
    if (!aggregator) {
      console.error("❌ No ATProto aggregator available - user not logged in?");
      return null;
    }

    try {
      return await aggregator.fetchPostThread(postUri);
    } catch (error) {
      console.error("❌ Failed to fetch post thread:", error);
      return null;
    }
  }

  getFeedName(feedUri: string): string {
    const aggregator = this.getAggregator();
    if (!aggregator) {
      return "📡 Custom Feed";
    }
    return aggregator.getFeedName(feedUri);
  }

  // Migration helper to convert old JSON configs to new Jazz root structure
  migrateEntityFeedConfig(account: any, objectId: string, entityFeedConfigJson: string): void {
    if (!entityFeedConfigJson || !account?.root?.feedConfigs) return;

    try {
      const oldConfig = JSON.parse(entityFeedConfigJson);
      
      // Skip if already migrated (check if config exists in root)
      if (account.root.feedConfigs[objectId]) {
        return;
      }

      // Extract relevant data (ignore old 'enabled' field)
      const config = {
        feeds: oldConfig.feeds || [],
        threadsOnly: oldConfig.threadsOnly || false,
      };

      // Only migrate if there are feeds to migrate
      if (config.feeds.length > 0) {
        this.setFeedConfig(account, objectId, config);
        console.log(`✅ Migrated feed config for object ${objectId}:`, config);
      }
    } catch (error) {
      console.warn(`❌ Failed to migrate feed config for object ${objectId}:`, error);
    }
  }

  // Bookmark management methods
  bookmarkThread(account: any, postUri: string, postData: { 
    title: string, 
    author: { handle: string, displayName?: string, avatar?: string }, 
    previewText: string, 
    feedSource?: string 
  }): boolean {
    console.log("🔖 Bookmarking thread:", postUri);
    
    if (!account?.root) {
      console.error("❌ Account root not available");
      return false;
    }

    // Initialize bookmarkedThreads if it doesn't exist
    if (!account.root.bookmarkedThreads) {
      console.log("🔧 Initializing bookmarkedThreads in account root");
      try {
        account.root.bookmarkedThreads = BookmarkedThreads.create([], publicGroup("writer"));
        console.log("✅ Successfully initialized bookmarkedThreads");
      } catch (error) {
        console.error("❌ Failed to initialize bookmarkedThreads:", error);
        return false;
      }
    }

    // Check if already bookmarked
    const existing = account.root.bookmarkedThreads.find((bookmark: any) => bookmark.postUri === postUri);
    if (existing) {
      console.log("ℹ️ Thread already bookmarked");
      return false;
    }

    try {
      const bookmark = BookmarkedThread.create({
        postUri,
        title: postData.title,
        author: {
          handle: postData.author.handle,
          displayName: postData.author.displayName,
          avatar: postData.author.avatar,
        },
        previewText: postData.previewText,
        bookmarkedAt: new Date(),
        feedSource: postData.feedSource,
      }, publicGroup("writer"));

      account.root.bookmarkedThreads.push(bookmark);
      console.log("✅ Successfully bookmarked thread");
      return true;
    } catch (error) {
      console.error("❌ Error bookmarking thread:", error);
      return false;
    }
  }

  removeBookmark(account: any, postUri: string): boolean {
    console.log("🗑️ Removing bookmark:", postUri);
    
    if (!account?.root?.bookmarkedThreads) {
      console.log("ℹ️ No bookmarks to remove");
      return false;
    }

    try {
      const index = account.root.bookmarkedThreads.findIndex((bookmark: any) => bookmark.postUri === postUri);
      if (index === -1) {
        console.log("ℹ️ Bookmark not found");
        return false;
      }

      account.root.bookmarkedThreads.splice(index, 1);
      console.log("✅ Successfully removed bookmark");
      return true;
    } catch (error) {
      console.error("❌ Error removing bookmark:", error);
      return false;
    }
  }

  getBookmarks(account: any): any[] {
    if (!account?.root?.bookmarkedThreads) {
      return [];
    }
    return Array.from(account.root.bookmarkedThreads);
  }

  isBookmarked(account: any, postUri: string): boolean {
    if (!account?.root?.bookmarkedThreads) {
      return false;
    }
    return account.root.bookmarkedThreads.some((bookmark: any) => bookmark.postUri === postUri);
  }

  // Hide management methods
  hideThread(account: any, postUri: string, reason?: string): boolean {
    console.log("🙈 Hiding thread:", postUri);
    
    if (!account?.root) {
      console.error("❌ Account root not available");
      return false;
    }

    // Initialize hiddenThreads if it doesn't exist
    if (!account.root.hiddenThreads) {
      console.log("🔧 Initializing hiddenThreads in account root");
      try {
        account.root.hiddenThreads = HiddenThreads.create([], publicGroup("writer"));
        console.log("✅ Successfully initialized hiddenThreads");
      } catch (error) {
        console.error("❌ Failed to initialize hiddenThreads:", error);
        return false;
      }
    }

    // Check if already hidden
    const existing = account.root.hiddenThreads.find((hidden: any) => hidden.postUri === postUri);
    if (existing) {
      console.log("ℹ️ Thread already hidden");
      return false;
    }

    try {
      const hiddenThread = HiddenThread.create({
        postUri,
        hiddenAt: new Date(),
        reason,
      }, publicGroup("writer"));

      account.root.hiddenThreads.push(hiddenThread);
      console.log("✅ Successfully hid thread");
      return true;
    } catch (error) {
      console.error("❌ Error hiding thread:", error);
      return false;
    }
  }

  unhideThread(account: any, postUri: string): boolean {
    console.log("👁️ Unhiding thread:", postUri);
    
    if (!account?.root?.hiddenThreads) {
      console.log("ℹ️ No hidden threads to unhide");
      return false;
    }

    try {
      const index = account.root.hiddenThreads.findIndex((hidden: any) => hidden.postUri === postUri);
      if (index === -1) {
        console.log("ℹ️ Thread not found in hidden list");
        return false;
      }

      account.root.hiddenThreads.splice(index, 1);
      console.log("✅ Successfully unhid thread");
      return true;
    } catch (error) {
      console.error("❌ Error unhiding thread:", error);
      return false;
    }
  }

  getHiddenThreads(account: any): any[] {
    if (!account?.root?.hiddenThreads) {
      return [];
    }
    return Array.from(account.root.hiddenThreads);
  }

  isHidden(account: any, postUri: string): boolean {
    if (!account?.root?.hiddenThreads) {
      return false;
    }
    return account.root.hiddenThreads.some((hidden: any) => hidden.postUri === postUri);
  }
}

// Global service instance
export const atprotoFeedService = new AtprotoFeedService();

// Add to global scope for debugging
if (typeof window !== "undefined") {
  (window as any).testAtprotoFeeds = async () => {
    console.log("🧪 Testing ATProto feed fetching...");
    const service = atprotoFeedService;
    try {
      const posts = await service.fetchFeedPosts(ATPROTO_FEEDS, false, 10);
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
  };
}