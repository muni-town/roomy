import { Agent } from "@atproto/api";
import type { FeedViewPost } from "@atproto/api/dist/client/types/app/bsky/feed/defs";

// ATProto dev feeds configuration
export const ATPROTO_FEED_CONFIG = {
  "at://did:plc:cbkjy5n7bk3ax2wplmtjofq2/app.bsky.feed.generator/Ewfwlxphc": {
    name: "🔧 AT Proto Dev",
    url: "https://bsky.app/profile/did:plc:cbkjy5n7bk3ax2wplmtjofq2/feed/Ewfwlxphc",
  },
  "at://did:plc:oio4hkxaop4ao4wz2pp3f4cr/app.bsky.feed.generator/atproto-threads":
    {
      name: "🧵 AT Proto Threads",
      url: "https://bsky.app/profile/did:plc:oio4hkxaop4ao4wz2pp3f4cr/feed/atproto-threads",
    },
  "at://did:plc:oio4hkxaop4ao4wz2pp3f4cr/app.bsky.feed.generator/atproto": {
    name: "⚡ AT Proto",
    url: "https://bsky.app/profile/did:plc:oio4hkxaop4ao4wz2pp3f4cr/feed/atproto",
  },
  "at://did:plc:2jtyqespp2zfodukwvktqwe6/app.bsky.feed.generator/atprotodev": {
    name: "🚀 AT Proto Dev Community",
    url: "https://bsky.app/profile/did:plc:2jtyqespp2zfodukwvktqwe6/feed/atprotodev",
  },
} as { [key: string]: { name: string; url: string } };

export const ATPROTO_FEEDS = Object.keys(ATPROTO_FEED_CONFIG);
export const FEED_NAMES: Record<string, string> = Object.fromEntries(
  Object.entries(ATPROTO_FEED_CONFIG).map(([uri, config]) => [
    uri,
    config.name,
  ]),
);

// Reusable function to add feeds from either URLs or URIs
export function addFeedToList(
  input: string,
  currentFeeds: string[],
  onSuccess?: (uri: string) => void,
  onError?: (message: string) => void,
): string[] {
  if (!input.trim()) return currentFeeds;

  let feedUri: string;

  // Check if it's already an AT:// URI
  if (input.startsWith("at://")) {
    feedUri = input;
  } else if (input.startsWith("http")) {
    // Try to convert URL to URI
    const result = convertBlueskyFeedUrlToUri(input);
    if (result) {
      feedUri = result.uri;
    } else {
      onError?.(
        "Invalid feed URL. Please use a URL like: https://any.domain/profile/did:plc:example/feed/feedname",
      );
      return currentFeeds;
    }
  } else {
    onError?.("Please enter either an AT:// URI or a valid feed URL");
    return currentFeeds;
  }

  // Add the feed if it's not already in the list
  if (!currentFeeds.includes(feedUri)) {
    onSuccess?.(feedUri);
    return [...currentFeeds, feedUri];
  }

  return currentFeeds;
}

// Convert AT Proto feed URL to AT Proto URI (works with any domain)
export function convertBlueskyFeedUrlToUri(
  url: string,
): { uri: string; name: string } | null {
  try {
    // Handle AT Proto feed URL format from any domain:
    // https://any.domain/profile/did:plc:example/feed/feedname
    // https://any.domain/profile/handle.bsky.social/feed/feedname

    const urlObj = new URL(url);

    const pathMatch = urlObj.pathname.match(
      /^\/profile\/([^\/]+)\/feed\/([^\/]+)$/,
    );
    if (!pathMatch) {
      return null;
    }

    const [, profile, feedName] = pathMatch;

    // If the profile looks like a DID, use it directly
    if (profile?.startsWith("did:") && feedName) {
      const uri = `at://${profile}/app.bsky.feed.generator/${feedName}`;

      // Generate a human-readable name from the feed name
      const displayName = feedName
        .split("-")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");

      return {
        uri,
        name: `📡 ${displayName}`,
      };
    }

    // For handles, we'll need to resolve the DID (for now, return null and ask user for URI)
    // In a full implementation, we'd resolve the handle to a DID via AT Proto API
    return null;
  } catch (e) {
    return null;
  }
}

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
  images?: string[]; // Array of image URLs from embeds
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
  private feedNames: Map<string, string> = new Map(); // Cache feed names from responses
  private feedNameCallbacks: Map<string, (() => void)[]> = new Map(); // Callbacks for when names are updated
  private readonly CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

  constructor(agent: Agent) {
    this.agent = agent;
  }

  // Get cached feed name or return a fallback
  getCachedFeedName(feedUri: string): string {
    if (this.feedNames.has(feedUri)) {
      return this.feedNames.get(feedUri)!;
    }

    // Check predefined feeds
    const entry = ATPROTO_FEED_CONFIG[feedUri];
    if (entry) {
      return entry.name;
    }

    return "📡 Custom Feed";
  }

  // Register a callback to be called when a feed name is updated
  onFeedNameUpdate(feedUri: string, callback: () => void): void {
    if (!this.feedNameCallbacks.has(feedUri)) {
      this.feedNameCallbacks.set(feedUri, []);
    }
    this.feedNameCallbacks.get(feedUri)!.push(callback);
  }

  // Trigger callbacks when a feed name is updated
  private triggerFeedNameCallbacks(feedUri: string): void {
    const callbacks = this.feedNameCallbacks.get(feedUri);
    if (callbacks) {
      callbacks.forEach((callback) => callback());
    }
  }

  // Fetch feed name from AT Proto
  async fetchFeedName(feedUri: string): Promise<string> {
    try {
      const response = await this.agent.app.bsky.feed.getFeedGenerator({
        feed: feedUri,
      });
      const name =
        response.data.view.displayName || this.extractFeedNameFromUri(feedUri);
      this.feedNames.set(feedUri, `📡 ${name}`);
      this.triggerFeedNameCallbacks(feedUri);
      console.log(`Successfully fetched feed name for ${feedUri}: ${name}`);
      return name;
    } catch (error) {
      console.warn(`Failed to fetch feed name for ${feedUri}:`, error);
      const fallback = this.extractFeedNameFromUri(feedUri);
      this.feedNames.set(feedUri, `📡 ${fallback}`);
      this.triggerFeedNameCallbacks(feedUri);
      return fallback;
    }
  }

  // Extract feed name from URI as fallback
  private extractFeedNameFromUri(feedUri: string): string {
    const match = feedUri.match(/\/([^\/]+)$/);
    if (match && match[1]) {
      const feedName = match[1];
      return feedName
        .split("-")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
    }
    return "Custom Feed";
  }

  private async fetchSingleFeed(
    feedUri: string,
    limit = 50,
  ): Promise<AtprotoFeedPost[]> {
    try {
      const response = await this.agent.app.bsky.feed.getFeed({
        feed: feedUri,
        limit,
      });

      // The getFeed response doesn't include generator info, so we need to fetch it separately
      // Check if we already have the name cached, if not, fetch it asynchronously
      if (!this.feedNames.has(feedUri) && !ATPROTO_FEED_CONFIG[feedUri]) {
        this.fetchFeedName(feedUri).catch((e) => {
          console.warn(`Failed to fetch feed name for ${feedUri}:`, e);
        });
      }

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
            if (typeof avatarUrl === "string" && avatarUrl.startsWith("http")) {
              return avatarUrl;
            }

            // If it's a blob reference, construct the CDN URL
            if (typeof avatarUrl === "string") {
              return `https://cdn.bsky.app/img/avatar/plain/${item.post.author.did}/${avatarUrl}@jpeg`;
            }

            // If it's an object (blob reference), try to extract the reference
            if (typeof avatarUrl === "object" && avatarUrl !== null) {
              const ref =
                (avatarUrl as any).ref ||
                (avatarUrl as any).$link ||
                (avatarUrl as any).cid;
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
        images: (() => {
          // Extract images from post embeds
          const embed = item.post.embed;
          if (!embed) return undefined;

          const images: string[] = [];

          // Handle different embed types
          if (
            embed.$type === "app.bsky.embed.images#view" &&
            "images" in embed
          ) {
            // Direct image embed
            embed.images?.forEach((img: any) => {
              if (img.fullsize) {
                images.push(img.fullsize);
              } else if (img.thumb) {
                images.push(img.thumb);
              }
            });
          } else if (
            embed.$type === "app.bsky.embed.recordWithMedia#view" &&
            "media" in embed
          ) {
            // Record with media (e.g., quote post with images)
            const media = embed.media;
            if (
              media &&
              media.$type === "app.bsky.embed.images#view" &&
              "images" in media
            ) {
              media.images?.forEach((img: any) => {
                if (img.fullsize) {
                  images.push(img.fullsize);
                } else if (img.thumb) {
                  images.push(img.thumb);
                }
              });
            }
          }

          return images.length > 0 ? images : undefined;
        })(),
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

  async fetchAggregatedFeed(
    limit = 50,
    feedUris?: string[],
  ): Promise<AtprotoFeedPost[]> {
    const feedsToFetch = feedUris || ATPROTO_FEEDS;
    const cacheKey = feedsToFetch.join(",");
    const now = Date.now();

    // Check cache
    if (
      this.cache.has(cacheKey) &&
      this.lastFetch.has(cacheKey) &&
      now - this.lastFetch.get(cacheKey)! < this.CACHE_DURATION
    ) {
      return this.cache.get(cacheKey)!;
    }

    // Fetch specified feeds in parallel
    const feedPromises = feedsToFetch.map((feedUri) =>
      this.fetchSingleFeed(feedUri, 30),
    );
    const feedResults = await Promise.all(feedPromises);

    // Combine and sort by creation time
    const allPosts = feedResults.flat();

    const sortedPosts = allPosts
      .sort(
        (a, b) =>
          new Date(b.record.createdAt).getTime() -
          new Date(a.record.createdAt).getTime(),
      )
      .slice(0, limit);

    // Remove duplicates by URI
    const uniquePosts = Array.from(
      new Map(sortedPosts.map((post) => [post.uri, post])).values(),
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
  async fetchThreadsOnly(
    limit = 50,
    feedUris?: string[],
  ): Promise<AtprotoFeedPost[]> {
    const allPosts = await this.fetchAggregatedFeed(limit * 2, feedUris); // Fetch more to filter
    return allPosts.filter((post) => this.isThreadPost(post)).slice(0, limit);
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

              if (
                typeof avatarUrl === "string" &&
                avatarUrl.startsWith("http")
              ) {
                return avatarUrl;
              }

              if (typeof avatarUrl === "string") {
                return `https://cdn.bsky.app/img/avatar/plain/${post.author.did}/${avatarUrl}@jpeg`;
              }

              if (typeof avatarUrl === "object" && avatarUrl !== null) {
                const ref =
                  (avatarUrl as any).ref ||
                  (avatarUrl as any).$link ||
                  (avatarUrl as any).cid;
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
          images: (() => {
            // Extract images from post embeds
            const embed = post.embed;
            if (!embed) return undefined;

            const images: string[] = [];

            // Handle different embed types
            if (embed.$type === "app.bsky.embed.images#view") {
              // Direct image embed
              embed.images?.forEach((img: any) => {
                if (img.fullsize) {
                  images.push(img.fullsize);
                } else if (img.thumb) {
                  images.push(img.thumb);
                }
              });
            } else if (embed.$type === "app.bsky.embed.recordWithMedia#view") {
              // Record with media (e.g., quote post with images)
              const media = embed.media;
              if (media && media.$type === "app.bsky.embed.images#view") {
                media.images?.forEach((img: any) => {
                  if (img.fullsize) {
                    images.push(img.fullsize);
                  } else if (img.thumb) {
                    images.push(img.thumb);
                  }
                });
              }
            }

            return images.length > 0 ? images : undefined;
          })(),
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

      if (
        !response.data.thread ||
        !("post" in response.data.thread) ||
        !response.data.thread.post
      ) {
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
      const did = this.agent?.did;
      if (!did) {
        console.error("No authenticated session available for liking post");
        return false;
      }

      await this.agent.api.com.atproto.repo.createRecord({
        repo: did,
        collection: "app.bsky.feed.like",
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
      const did = this.agent?.did;
      if (!did) {
        console.error("No authenticated session available for reposting post");
        return false;
      }

      await this.agent.api.com.atproto.repo.createRecord({
        repo: did,
        collection: "app.bsky.feed.repost",
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
  async replyToPost(
    postUri: string,
    postCid: string,
    text: string,
    rootUri?: string,
    rootCid?: string,
  ): Promise<boolean> {
    try {
      const did = this.agent?.did;
      if (!did) {
        console.error(
          "No authenticated session available for replying to post",
        );
        return false;
      }

      await this.agent.api.com.atproto.repo.createRecord({
        repo: did,
        collection: "app.bsky.feed.post",
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
