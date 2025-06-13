import { Agent } from "@atproto/api";
import type { FeedViewPost } from "@atproto/api/dist/client/types/app/bsky/feed/defs";

// ATProto dev feeds configuration
export const ATPROTO_FEED_CONFIG = {
  "at://did:plc:cbkjy5n7bk3ax2wplmtjofq2/app.bsky.feed.generator/Ewfwlxphc": {
    name: "🔧 AT Proto Dev",
    url: "https://bsky.app/profile/did:plc:cbkjy5n7bk3ax2wplmtjofq2/feed/Ewfwlxphc"
  },
  "at://did:plc:oio4hkxaop4ao4wz2pp3f4cr/app.bsky.feed.generator/atproto-threads": {
    name: "🧵 AT Proto Threads", 
    url: "https://bsky.app/profile/did:plc:oio4hkxaop4ao4wz2pp3f4cr/feed/atproto-threads"
  },
  "at://did:plc:oio4hkxaop4ao4wz2pp3f4cr/app.bsky.feed.generator/atproto": {
    name: "⚡ AT Proto",
    url: "https://bsky.app/profile/did:plc:oio4hkxaop4ao4wz2pp3f4cr/feed/atproto"
  },
  "at://did:plc:2jtyqespp2zfodukwvktqwe6/app.bsky.feed.generator/atprotodev": {
    name: "🚀 AT Proto Dev Community",
    url: "https://bsky.app/profile/did:plc:2jtyqespp2zfodukwvktqwe6/feed/atprotodev"
  }
} as const;

export const ATPROTO_FEEDS = Object.keys(ATPROTO_FEED_CONFIG);
export const FEED_NAMES: Record<string, string> = Object.fromEntries(
  Object.entries(ATPROTO_FEED_CONFIG).map(([uri, config]) => [uri, config.name])
);

export interface AtprotoFeedPost {
  uri: string;
  cid: string;
  author: {
    did: string;
    handle: string;
    displayName?: string;
    avatar?: string;
  };
  record: {
    text: string;
    createdAt: string;
    reply?: {
      root: { uri: string; cid: string };
      parent: { uri: string; cid: string };
    };
  };
  replyCount?: number;
  repostCount?: number;
  likeCount?: number;
  indexedAt: string;
  feedSource?: string; // Which feed this post came from
}

export interface AtprotoThreadPost extends AtprotoFeedPost {
  replies?: AtprotoThreadPost[];
  parent?: AtprotoThreadPost;
  cid: string; // Ensure CID is always available for interactions
}

export class AtprotoFeedAggregator {
  private agent: Agent;
  private cache: Map<string, AtprotoFeedPost[]> = new Map();
  private lastFetch: Map<string, number> = new Map();
  private readonly CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

  constructor(agent: Agent) {
    this.agent = agent;
  }

  private async fetchSingleFeed(feedUri: string, limit = 50): Promise<AtprotoFeedPost[]> {
    try {
      const response = await this.agent.app.bsky.feed.getFeed({
        feed: feedUri,
        limit,
      });
      
      return response.data.feed.map((item: FeedViewPost) => ({
        uri: item.post.uri,
        cid: item.post.cid,
        author: {
          did: item.post.author.did,
          handle: item.post.author.handle,
          displayName: item.post.author.displayName,
          avatar: (() => {
            if (!item.post.author.avatar) return undefined;
            
            let avatarUrl = item.post.author.avatar;
            
            // If it's already a full URL, use it as-is
            if (typeof avatarUrl === 'string' && avatarUrl.startsWith('http')) {
              return avatarUrl;
            }
            
            // If it's a blob reference, construct the CDN URL
            if (typeof avatarUrl === 'string') {
              return `https://cdn.bsky.app/img/avatar/plain/${item.post.author.did}/${avatarUrl}@jpeg`;
            }
            
            // If it's an object (blob reference), try to extract the reference
            if (typeof avatarUrl === 'object' && avatarUrl !== null) {
              const ref = (avatarUrl as any).ref || (avatarUrl as any).$link || (avatarUrl as any).cid;
              if (ref) {
                return `https://cdn.bsky.app/img/avatar/plain/${item.post.author.did}/${ref}@jpeg`;
              }
            }
            
            return undefined;
          })(),
        },
        record: {
          text: (item.post.record as any).text || "",
          createdAt: (item.post.record as any).createdAt || item.post.indexedAt,
          reply: (item.post.record as any).reply,
        },
        replyCount: item.post.replyCount,
        repostCount: item.post.repostCount, 
        likeCount: item.post.likeCount,
        indexedAt: item.post.indexedAt,
        feedSource: feedUri,
      }));
    } catch (error) {
      console.error(`Failed to fetch feed ${feedUri}:`, error);
      return [];
    }
  }

  async fetchAggregatedFeed(limit = 50): Promise<AtprotoFeedPost[]> {
    const now = Date.now();
    const cacheKey = "aggregated";
    
    // Check cache
    if (this.cache.has(cacheKey) && 
        this.lastFetch.has(cacheKey) && 
        now - this.lastFetch.get(cacheKey)! < this.CACHE_DURATION) {
      return this.cache.get(cacheKey)!;
    }

    // Fetch all feeds in parallel
    const feedPromises = ATPROTO_FEEDS.map(feedUri => this.fetchSingleFeed(feedUri, 30));
    const feedResults = await Promise.all(feedPromises);
    
    // Combine and sort by creation time
    const allPosts = feedResults.flat();
    
    const sortedPosts = allPosts
      .sort((a, b) => new Date(b.record.createdAt).getTime() - new Date(a.record.createdAt).getTime())
      .slice(0, limit);

    // Remove duplicates by URI
    const uniquePosts = Array.from(
      new Map(sortedPosts.map(post => [post.uri, post])).values()
    );

    // Cache result
    this.cache.set(cacheKey, uniquePosts);
    this.lastFetch.set(cacheKey, now);

    return uniquePosts;
  }

  // Check if a post is part of a thread (has replies or is a reply)
  isThreadPost(post: AtprotoFeedPost): boolean {
    return !!(post.record.reply || (post.replyCount && post.replyCount > 0));
  }

  // Get only thread posts (for threads-only channel)
  async fetchThreadsOnly(limit = 50): Promise<AtprotoFeedPost[]> {
    const allPosts = await this.fetchAggregatedFeed(limit * 2); // Fetch more to filter
    return allPosts.filter(post => this.isThreadPost(post)).slice(0, limit);
  }

  // Fetch full thread context for a post
  async fetchPostThread(postUri: string): Promise<AtprotoThreadPost | null> {
    try {
      const response = await this.agent.app.bsky.feed.getPostThread({
        uri: postUri,
        depth: 10, // Get deep thread context
      });

      // Transform the thread response into our format
      const convertThreadPost = (threadView: any): AtprotoThreadPost => {
        const post = threadView.post;
        
        const converted: AtprotoThreadPost = {
          uri: post.uri,
          cid: post.cid,
          author: {
            did: post.author.did,
            handle: post.author.handle,
            displayName: post.author.displayName,
            avatar: (() => {
              if (!post.author.avatar) return undefined;
              
              let avatarUrl = post.author.avatar;
              
              if (typeof avatarUrl === 'string' && avatarUrl.startsWith('http')) {
                return avatarUrl;
              }
              
              if (typeof avatarUrl === 'string') {
                return `https://cdn.bsky.app/img/avatar/plain/${post.author.did}/${avatarUrl}@jpeg`;
              }
              
              if (typeof avatarUrl === 'object' && avatarUrl !== null) {
                const ref = (avatarUrl as any).ref || (avatarUrl as any).$link || (avatarUrl as any).cid;
                if (ref) {
                  return `https://cdn.bsky.app/img/avatar/plain/${post.author.did}/${ref}@jpeg`;
                }
              }
              
              return undefined;
            })(),
          },
          record: {
            text: (post.record as any).text || "",
            createdAt: (post.record as any).createdAt || post.indexedAt,
            reply: (post.record as any).reply,
          },
          replyCount: post.replyCount,
          repostCount: post.repostCount,
          likeCount: post.likeCount,
          indexedAt: post.indexedAt,
          feedSource: undefined, // Thread posts don't have feed source
        };

        // Add replies if they exist
        if (threadView.replies && threadView.replies.length > 0) {
          converted.replies = threadView.replies
            .filter((reply: any) => reply?.post) // Filter out blocked/deleted replies
            .map((reply: any) => convertThreadPost(reply));
        }

        return converted;
      };

      if (!response.data.thread?.post) {
        return null;
      }

      const rootPost = convertThreadPost(response.data.thread);
      return rootPost;
    } catch (error) {
      console.error(`Failed to fetch thread for ${postUri}:`, error);
      return null;
    }
  }

  // Like a post
  async likePost(postUri: string, postCid: string): Promise<boolean> {
    try {
      await this.agent.api.com.atproto.repo.createRecord({
        repo: this.agent.session?.did ?? '',
        collection: 'app.bsky.feed.like',
        record: {
          subject: {
            uri: postUri,
            cid: postCid,
          },
          createdAt: new Date().toISOString(),
        },
      });
      return true;
    } catch (error) {
      console.error(`Failed to like post ${postUri}:`, error);
      return false;
    }
  }

  // Repost a post
  async repostPost(postUri: string, postCid: string): Promise<boolean> {
    try {
      await this.agent.api.com.atproto.repo.createRecord({
        repo: this.agent.session?.did ?? '',
        collection: 'app.bsky.feed.repost',
        record: {
          subject: {
            uri: postUri,
            cid: postCid,
          },
          createdAt: new Date().toISOString(),
        },
      });
      return true;
    } catch (error) {
      console.error(`Failed to repost post ${postUri}:`, error);
      return false;
    }
  }

  // Reply to a post
  async replyToPost(postUri: string, postCid: string, text: string, rootUri?: string, rootCid?: string): Promise<boolean> {
    try {
      await this.agent.api.com.atproto.repo.createRecord({
        repo: this.agent.session?.did ?? '',
        collection: 'app.bsky.feed.post',
        record: {
          text: text,
          reply: {
            root: {
              uri: rootUri || postUri,
              cid: rootCid || postCid,
            },
            parent: {
              uri: postUri,
              cid: postCid,
            },
          },
          createdAt: new Date().toISOString(),
        },
      });
      return true;
    } catch (error) {
      console.error(`Failed to reply to post ${postUri}:`, error);
      return false;
    }
  }

  // Clear cache (useful for manual refresh)
  clearCache(): void {
    this.cache.clear();
    this.lastFetch.clear();
  }
}