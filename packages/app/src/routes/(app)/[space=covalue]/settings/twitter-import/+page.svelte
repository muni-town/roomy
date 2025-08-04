<script lang="ts" module>
  export interface SimplifiedTweet {
    id: string;
    text: string;
    createdAt: string;
    isRetweet: boolean;
    retweetCount: number;
    favoriteCount: number;
    language: string;
    source: string;
    userMentions: UserMention[];
    hashtags: Hashtag[];
    urls: Url[];
    media: Media[];
    isEdited: boolean;
    isSensitive: boolean;
    inReplyToStatusId?: string;
    inReplyToUserId?: string;
    replies: Map<string, SimplifiedTweet>;
  }

  export interface UserMention {
    name: string;
    screenName: string;
    id: string;
    indices: [number, number];
  }

  export interface Hashtag {
    text: string;
    indices: [number, number];
  }

  export interface Url {
    url: string;
    expandedUrl: string;
    displayUrl: string;
    indices: [number, number];
  }

  export interface Media {
    type: "photo" | "video" | "animated_gif";
    url: string;
    mediaUrl: string;
    mediaUrlHttps: string;
    expandedUrl: string;
    displayUrl: string;
    indices: [number, number];
    sizes?: {
      small: MediaSize;
      medium: MediaSize;
      large: MediaSize;
      thumb: MediaSize;
    };
    videoInfo?: {
      durationMillis: number;
      aspectRatio: [number, number];
      variants: VideoVariant[];
    };
    localFile?: string | null;
    expectedFilename?: string | null;
  }

  export interface MediaSize {
    w: number;
    h: number;
    resize: "fit" | "crop";
  }

  export interface VideoVariant {
    contentType: string;
    url: string;
    bitrate?: number;
  }

  // Raw Twitter export types
  interface RawTweetExport {
    tweet: RawTweet;
  }

  interface RawTweet {
    id_str: string;
    full_text: string;
    created_at: string;
    retweeted: boolean;
    retweet_count: string;
    favorite_count: string;
    lang: string;
    source: string;
    entities: RawEntities;
    extended_entities?: RawExtendedEntities;
    edit_info?: RawEditInfo;
    possibly_sensitive?: boolean;
    in_reply_to_status_id?: string;
    in_reply_to_user_id?: string;
  }

  interface RawEntities {
    user_mentions: RawUserMention[];
    hashtags: RawHashtag[];
    urls: RawUrl[];
    media?: RawMedia[];
  }

  interface RawExtendedEntities {
    media: RawMedia[];
  }

  interface RawUserMention {
    name: string;
    screen_name: string;
    id_str: string;
    indices: [string, string];
  }

  interface RawHashtag {
    text: string;
    indices: [string, string];
  }

  interface RawUrl {
    url: string;
    expanded_url: string;
    display_url: string;
    indices: [string, string];
  }

  interface RawMedia {
    type: string;
    url: string;
    media_url: string;
    media_url_https: string;
    expanded_url: string;
    display_url: string;
    indices: [string, string];
    sizes?: Record<string, RawMediaSize>;
    video_info?: RawVideoInfo;
  }

  interface RawMediaSize {
    w: number;
    h: number;
    resize: string;
  }

  interface RawVideoInfo {
    duration_millis: string;
    aspect_ratio: [string, string];
    variants: RawVideoVariant[];
  }

  interface RawVideoVariant {
    content_type: string;
    url: string;
    bitrate?: number;
  }

  interface RawEditInfo {
    initial: {
      editTweetIds: string[];
      editableUntil: string;
      editsRemaining: string;
      isEditEligible: boolean;
    };
  }

  /**
   * Parse a single tweet from the Twitter export format to our simplified format
   */
  export function parseTweet(rawTweetExport: RawTweetExport): SimplifiedTweet {
    const tweet = rawTweetExport.tweet;

    // Determine if this is a retweet by checking if the text starts with "RT @"
    const isRetweet = tweet.full_text.startsWith("RT @");

    // Parse user mentions
    const userMentions: UserMention[] = (
      tweet.entities.user_mentions || []
    ).map((mention) => ({
      name: mention.name,
      screenName: mention.screen_name,
      id: mention.id_str,
      indices: [parseInt(mention.indices[0]), parseInt(mention.indices[1])],
    }));

    // Parse hashtags
    const hashtags: Hashtag[] = (tweet.entities.hashtags || []).map(
      (hashtag) => ({
        text: hashtag.text,
        indices: [parseInt(hashtag.indices[0]), parseInt(hashtag.indices[1])],
      }),
    );

    // Parse URLs
    const urls: Url[] = (tweet.entities.urls || []).map((url) => ({
      url: url.url,
      expandedUrl: url.expanded_url,
      displayUrl: url.display_url,
      indices: [parseInt(url.indices[0]), parseInt(url.indices[1])],
    }));

    // Parse media (check both entities and extended_entities)
    const mediaEntities = tweet.entities.media || [];
    const extendedMediaEntities = tweet.extended_entities?.media || [];
    const allMediaEntities = [...mediaEntities, ...extendedMediaEntities];

    const media: Media[] = allMediaEntities.map((media) => ({
      type: media.type as "photo" | "video" | "animated_gif",
      url: media.url,
      mediaUrl: media.media_url,
      mediaUrlHttps: media.media_url_https,
      expandedUrl: media.expanded_url,
      displayUrl: media.display_url,
      indices: [parseInt(media.indices[0]), parseInt(media.indices[1])],
      sizes:
        media.sizes &&
        media.sizes.small &&
        media.sizes.medium &&
        media.sizes.large &&
        media.sizes.thumb
          ? {
              small: {
                w: media.sizes.small.w,
                h: media.sizes.small.h,
                resize: media.sizes.small.resize as "fit" | "crop",
              },
              medium: {
                w: media.sizes.medium.w,
                h: media.sizes.medium.h,
                resize: media.sizes.medium.resize as "fit" | "crop",
              },
              large: {
                w: media.sizes.large.w,
                h: media.sizes.large.h,
                resize: media.sizes.large.resize as "fit" | "crop",
              },
              thumb: {
                w: media.sizes.thumb.w,
                h: media.sizes.thumb.h,
                resize: media.sizes.thumb.resize as "fit" | "crop",
              },
            }
          : undefined,
      videoInfo: media.video_info
        ? {
            durationMillis: parseInt(media.video_info.duration_millis),
            aspectRatio: [
              parseInt(media.video_info.aspect_ratio[0]),
              parseInt(media.video_info.aspect_ratio[1]),
            ],
            variants: media.video_info.variants.map((variant) => ({
              contentType: variant.content_type,
              url: variant.url,
              bitrate: variant.bitrate,
            })),
          }
        : undefined,
    }));

    return {
      id: tweet.id_str,
      text: tweet.full_text,
      createdAt: tweet.created_at,
      isRetweet,
      retweetCount: parseInt(tweet.retweet_count),
      favoriteCount: parseInt(tweet.favorite_count),
      language: tweet.lang,
      source: tweet.source,
      userMentions,
      hashtags,
      urls,
      media,
      isEdited: !!tweet.edit_info,
      isSensitive: tweet.possibly_sensitive || false,
      inReplyToStatusId: tweet.in_reply_to_status_id,
      inReplyToUserId: tweet.in_reply_to_user_id,
      replies: new Map(),
    };
  }

  /**
   * Parse the entire tweets array from the Twitter export
   */
  export function parseTweetsArray(
    tweetsArray: RawTweetExport[],
  ): SimplifiedTweet[] {
    return tweetsArray.map(parseTweet);
  }

  export function mapTweetMediaToFiles(
    tweet: SimplifiedTweet,
    files: File[],
  ): Media[] {
    const filenameSet = new Set<string>();
    return tweet.media
      .map((media) => {
        let expectedFilename: string | null = null;

        if (media.type === "video" && media.videoInfo) {
          // For videos, find the highest quality variant
          const videoVariants = media.videoInfo.variants.filter(
            (v) => v.bitrate,
          );
          if (videoVariants.length > 0) {
            // Sort by bitrate (highest first) and take the first one
            const highestBitrateVariant = videoVariants.sort(
              (a, b) => (b.bitrate || 0) - (a.bitrate || 0),
            )[0];

            if (highestBitrateVariant) {
              // Extract filename from URL: .../VIU-I8HTSKez6FIV.mp4?tag=12
              const urlMatch =
                highestBitrateVariant.url.match(/\/([^\/\?]+)(?:\?|$)/);
              if (urlMatch) {
                expectedFilename = `${tweet.id}-${urlMatch[1]}`;
              }
            }
          }
        } else if (media.type === "photo" || media.type === "animated_gif") {
          // For photos, extract from media_url_https
          // URL pattern: https://pbs.twimg.com/media/FAyu4vjWQAAK-vL.jpg?format=jpg&name=large
          const urlMatch = media.mediaUrlHttps.match(/\/([^\/\?]+)(?:\?|$)/);
          if (urlMatch) {
            expectedFilename = `${tweet.id}-${urlMatch[1]}`;
          }
        }

        // Look for matching file
        const matchingFiles = expectedFilename
          ? files
              .filter((file: File) =>
                file.webkitRelativePath.startsWith(expectedFilename),
              )
              .map((file: File) => file.webkitRelativePath)
          : [];

        console.log("matchingFiles", matchingFiles);

        // if the set already has the file, we want to return a filename of null so it gets filtered out

        let filename: string | null = null;
        if (matchingFiles.length > 0) {
          filename = matchingFiles[0] || null;
          if (filename && filenameSet.has(filename)) {
            filename = null;
          } else {
            filenameSet.add(filename || "");
          }
        }

        return {
          ...media,
          localFile: filename,
          expectedFilename: expectedFilename,
        };
      })
      .filter((media) => media.localFile !== null);
  }
</script>

<script lang="ts">
  import { page } from "$app/state";
  import { user } from "$lib/user.svelte";
  import { Alert, Button } from "@fuxui/base";
  import {
    addToFolder,
    AllThreadsComponent,
    co,
    CoFeed,
    createMessage,
    createThread,
    MediaUploadQueue,
    RoomyAccount,
    RoomyEntity,
    SpacePermissionsComponent,
    SubThreadsComponent,
    ThreadComponent,
    ThreadContent,
    UploadMedia,
    type ImageUrlEmbedCreate,
    type VideoUrlEmbedCreate,
  } from "@roomy-chat/sdk";
  import { AccountCoState, CoState } from "jazz-tools/svelte";
  import toast from "svelte-french-toast";

  interface QueuedTweet {
    tweet: SimplifiedTweet;
    status: "pending" | "posted" | "failed";
    id?: string;
  }

  let logs = $state<string[]>([]);
  let fileInput = $state<HTMLInputElement | null>(null);
  let container = $state<HTMLDivElement | null>(null);
  let fileList = $state<File[]>([]);
  let isImporting = $state(false);
  let isFinished = $state(false);
  let tweetsQueue = $state<Map<string, QueuedTweet>>(new Map());
  let twitterAccountId = $state("");
  let space = $derived(
    new CoState(RoomyEntity, page.params.space, {
      resolve: {
        components: {
          $each: true,
          $onError: null,
        },
      },
    }),
  );
  const account = new AccountCoState(RoomyAccount, {
    resolve: {
      root: {
        uploadQueue: true,
      },
    },
  });
  const me = $derived(account.current);
  let importQueue = $derived(me?.root.uploadQueue);
  const permissions = $derived(
    new CoState(
      SpacePermissionsComponent.schema,
      space?.current?.components?.[SpacePermissionsComponent.id],
    ),
  );
  const allThreads = $derived(
    new CoState(
      AllThreadsComponent.schema,
      space?.current?.components?.[AllThreadsComponent.id],
    ),
  );
  const tweetsJs = $derived(
    fileList.find((file) => file.webkitRelativePath.includes("tweets.js")),
  );
  const tweetsPart1js = $derived(
    fileList.find((file) =>
      file.webkitRelativePath.includes("tweets-part1.js"),
    ),
  );
  const mediaFiles = $derived(
    fileList.filter((file) =>
      file.webkitRelativePath.includes("/tweets_media/"),
    ),
  );
  const accountFile = $derived(
    fileList.find((file) => file.webkitRelativePath.includes("account.js")),
  );

  $effect(() => {
    space.current?.ensureLoaded({
      resolve: {
        components: {
          $each: true,
          $onError: null,
        },
      },
    });
    permissions.current?.ensureLoaded({
      resolve: true,
    });
  });

  $effect(() => {
    if (accountFile && !twitterAccountId) {
      const getAccountId = async () => {
        const text = await accountFile.text();
        const jsonText = text?.replace(`window.YTD.account.part0 = `, "");
        const account = JSON.parse(jsonText || "{}");
        console.log(account);
        twitterAccountId = account[0].account.accountId;
      };
      getAccountId();
    }
  });

  $effect(() => {
    if (tweetsJs) {
      tweetsJs.text().then((text) => parseTweets(text, 0));
    }

    if (tweetsPart1js) {
      tweetsPart1js.text().then((text) => parseTweets(text, 1));
    }
  });

  $effect(() => {
    logs.length;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  });

  let pending: string[] = [];
  let scheduled = false;

  export function pushLog(log: string) {
    pending.push(log);

    if (!scheduled) {
      scheduled = true;

      queueMicrotask(() => {
        logs = [...logs, ...pending];
        pending = [];
        scheduled = false;
      });
    }
  }

  function findParent(
    parentId: string,
    rootTweets: Map<string, SimplifiedTweet>,
    replies: SimplifiedTweet[],
    repliesMap: Map<string, string>,
  ): SimplifiedTweet | null {
    // console.log("finding parent", parentId)
    const rootTweetKeys = Array.from(rootTweets.keys());

    // case 1 - parent is a root tweet
    if (rootTweetKeys.some((key) => key.includes(parentId))) {
      // console.log("found root tweet", parentId)
      const rootTweetKey = rootTweetKeys.find((key) => key.includes(parentId));
      const rootTweet = rootTweets.get(rootTweetKey!);
      return rootTweet!;
    }

    // case 2 - parent is a reply
    if (repliesMap.has(parentId)) {
      const grandparentId = repliesMap.get(parentId);

      if (grandparentId) {
        const grandparent = findParent(
          grandparentId,
          rootTweets,
          replies,
          repliesMap,
        );
        if (grandparent) {
          // console.log("found grandparent", grandparentId)
          let parent = grandparent.replies.get(parentId);
          if (parent) {
            // console.log("found parent", parentId)
            return parent;
          }
          // console.log("no parent found in grandparent", parentId)
          parent = replies.find((r) => r.id === parentId);
          if (parent) {
            // console.log("found parent in replies", parentId)
            grandparent.replies.set(parent.id, parent);
            return parent;
          }
        }
      }
    }

    // case 3 - no parent found
    console.log("pathological case: no parent found", parentId);
    return null;
  }

  async function createAndInsertChannel(
    name: string,
    permissions: Record<string, string>,
    space: co.loaded<typeof RoomyEntity>,
    allThreads: co.loaded<(typeof AllThreadsComponent)["schema"]>,
  ) {
    const channel = await createThread(name, permissions);
    if (!channel) throw new Error("Channel could not be created");
    addToFolder(space, channel.roomyObject);
    allThreads.push(channel.roomyObject);
    if (!channel.roomyObject.components[ThreadComponent.id])
      throw new Error("Thread component not found in channel");
    if (!channel.roomyObject.components[SubThreadsComponent.id])
      throw new Error("Subthreads component not found in channel");
    const threadContent = await ThreadContent.load(
      channel.roomyObject.components[ThreadComponent.id]!,
      {
        resolve: {
          timeline: true,
        },
      },
    );
    const subThreadsFeed = await SubThreadsComponent.schema.load(
      channel.roomyObject.components[SubThreadsComponent.id]!,
      {
        resolve: {
          $each: true,
        },
      },
    );
    if (!threadContent || !subThreadsFeed)
      throw new Error("Thread content or subthreads content not found");
    return {
      timeline: threadContent.timeline,
      subThreadsFeed,
    };
  }

  async function createAndInsertSubthread(
    name: string,
    permissions: Record<string, string>,
    allThreads: co.loaded<(typeof AllThreadsComponent)["schema"]>,
    subThreads: co.loaded<(typeof SubThreadsComponent)["schema"]>,
    parentId: string,
  ) {
    parentId; //use?
    const channel = await createThread(name, permissions);
    if (!channel) throw new Error("Channel could not be created");
    allThreads.push(channel.roomyObject); // is this right?
    subThreads.push(channel.roomyObject);
    if (!channel.roomyObject.components[ThreadComponent.id])
      throw new Error("Thread component not found in channel");
    const threadContent = await ThreadContent.load(
      channel.roomyObject.components[ThreadComponent.id]!,
      {
        resolve: {
          timeline: true,
        },
      },
    );
    if (!threadContent)
      throw new Error("Thread content or subthreads content not found");
    return {
      timeline: threadContent.timeline,
    };
  }

  async function importTweets() {
    if (isImporting) return;
    try {
      if (!space.current || allThreads.current)
        throw new Error("No current space");
      if (!permissions.current) {
        console.log("permisions", permissions);
        throw new Error("no permissions");
      }
      if (!twitterAccountId) throw new Error("no account id");
      isImporting = true;
      await me?.root.ensureLoaded({ resolve: { uploadQueue: true } });
      // Populate the upload queue
      if (!me) throw new Error("Account not loaded");
      if (!me.root.uploadQueue)
        me.root.uploadQueue = MediaUploadQueue.create({});
      const uploadQueue = me.root.uploadQueue;
      if (!uploadQueue) throw new Error("no upload queue");

      mediaFiles.forEach((file) => {
        if (!uploadQueue[file.webkitRelativePath]) {
          uploadQueue[file.webkitRelativePath] = UploadMedia.create({
            path: file.webkitRelativePath,
            mediaType: file.type.startsWith("video") ? "video" : "image",
            status: "pending",
          });
        }
      });

      pushLog("📤 Queued " + Object.keys(uploadQueue).length + " uploads");

      await uploadMediaFiles(uploadQueue, fileList);

      // Then, create channels
      let mainChannel = await createAndInsertChannel(
        "Tweets",
        permissions.current!,
        space.current!,
        allThreads.current!,
      );
      let repliesChannel = await createAndInsertChannel(
        "Replies",
        permissions.current!,
        space.current!,
        allThreads.current!,
      );
      let retweetsChannel = await createAndInsertChannel(
        "Retweets",
        permissions.current!,
        space.current!,
        allThreads.current!,
      );

      pushLog("🌱 Channel created: Twitter Import.");

      pushLog("📚 Organising tweets into threads...");

      const allTweets = [...tweetsQueue.values()].map((t) => t.tweet);
      const rootTweets = new Map(
        allTweets
          .filter((t) => !t.inReplyToStatusId)
          .filter((t) => !t.text.startsWith("RT @"))
          .map((t) => [`${new Date(t.createdAt).valueOf()}-${t.id}`, t]),
      );
      const replies = allTweets.filter(
        (t) => !!t.inReplyToStatusId && t.inReplyToUserId !== twitterAccountId,
      );
      const retweets = allTweets.filter((t) => t.text.startsWith("RT @"));
      const selfReplies = allTweets.filter(
        (t) => !!t.inReplyToStatusId && t.inReplyToUserId === twitterAccountId,
      );

      const repliesMap = new Map(
        selfReplies
          .map((r) => [r.id, r.inReplyToStatusId!] as const)
          .concat(replies.map((r) => [r.id, r.inReplyToStatusId!] as const)),
      );

      console.log("rootTweets", rootTweets);

      // sort tweets into thread tree
      for (const reply of selfReplies) {
        const parent = findParent(
          reply.inReplyToStatusId!,
          rootTweets,
          selfReplies,
          repliesMap,
        );
        if (parent) {
          parent.replies.set(
            `${new Date(reply.createdAt).valueOf()}-${reply.id}`,
            reply,
          ); // does this mutate the rootTweets map?
        }
      }

      const postTweet = async (
        tweet: SimplifiedTweet,
        channel: {
          timeline: CoFeed<string>;
          subThreads?: co.loaded<(typeof SubThreadsComponent)["schema"]>;
        },
      ) => {
        // for each one, we have to get the URL for any attached media
        const uploadMediaUrls = Object.keys(uploadQueue!).filter(
          (path) => tweet.id && path.includes(tweet.id),
        );
        const uploadMedia = uploadMediaUrls
          .map((key) => uploadQueue![key])
          .filter((m) => m && m.url);
        const uploadedMediaImageUrls = uploadMedia
          .filter((m) => m!.mediaType === "image")
          .map((m) => {
            return {
              type: "imageUrl",
              data: {
                url: m!.url!,
              },
            } as const;
          });
        const uploadedMediaVideoUrls = uploadMedia
          .filter((m) => m!.mediaType === "video")
          .map((m) => {
            return {
              type: "videoUrl",
              data: {
                url: m!.url!,
              },
            } as const;
          });

        // and then, post the message in the channel
        let fileUrlEmbeds: (ImageUrlEmbedCreate | VideoUrlEmbedCreate)[] = [];
        fileUrlEmbeds.push(...uploadedMediaImageUrls);
        fileUrlEmbeds.push(...uploadedMediaVideoUrls);

        const messageText = tweet.text;
        const message = await createMessage(messageText, permissions.current!, {
          embeds: fileUrlEmbeds,
          created: new Date(tweet.createdAt),
        });
        channel.timeline.push(message.roomyObject.id);

        // for tweets in the root channel with replies,
        // we create a subthread and post replies there
        if (channel.subThreads && tweet.replies.size > 0) {
          const subThread = await createAndInsertSubthread(
            messageText,
            permissions.current!,
            allThreads.current!,
            channel.subThreads,
            message.roomyObject.id,
          );

          // post the original message here as well
          subThread.timeline.push(message.roomyObject.id);

          // sort replies & post in the subthread
          const replyKeys = Array.from(tweet.replies.keys()).sort();
          for (const replyKey of replyKeys) {
            const reply = tweet.replies.get(replyKey);
            if (!reply) continue;
            await postTweet(reply, subThread);
          }
        }

        // for tweets in a subthread that have replies,
        // we post them in that subthread
        if (!channel.subThreads && tweet.replies.size > 0) {
          // sort replies and post in the current channel (which is a subthread)
          const replyKeys = Array.from(tweet.replies.keys()).sort();
          for (const replyKey of replyKeys) {
            const reply = tweet.replies.get(replyKey);
            if (!reply) continue;
            await postTweet(reply, channel);
          }
        }
      };

      // sort tweets
      const sortedRootTweetKeys = Array.from(rootTweets.keys()).sort();
      for (const key of sortedRootTweetKeys) {
        const tweet = rootTweets.get(key)!;
        await postTweet(tweet, mainChannel);
      }

      const sortedReplies = replies.sort(
        (a, b) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );
      for (const reply of sortedReplies) {
        await postTweet(reply, repliesChannel);
      }

      const sortedRetweets = retweets
        .reverse()
        .sort(
          (a, b) =>
            new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
        );
      for (const tweet of sortedRetweets) {
        await postTweet(tweet, retweetsChannel);
      }

      pushLog(
        "🎉 Finished Importing Tweets! Go to the 'Tweets' and 'Retweets' channels to see them.",
      );
      toast.success(
        "🎉 Finished Importing Tweets! Go to the 'Tweets' and 'Retweets' channels to see them.",
        {
          position: "bottom-right",
        },
      );
    } catch (e: any) {
      toast.error("😔 " + e.message, {
        position: "bottom-right",
      });
    }
    isImporting = false;
    isFinished = true;
  }

  async function handleFolderSelect(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      console.log(input.files);
      fileList = Array.from(input.files ?? []);
    }
  }

  async function parseTweets(text: string, part: number) {
    const newText = text.replace(`window.YTD.tweets.part${part} = `, "");
    const tweets = JSON.parse(newText);
    pushLog(`🐤 Tweets part${part} parsed, found ${tweets.length} tweets`);

    const parsedTweets = parseTweetsArray(tweets);
    console.log("Parsed Tweets", parsedTweets);
    for (const tweet of parsedTweets) {
      // insert tweet into map keyed by unix timestamp + id, so we can post in order
      tweetsQueue.set(`${new Date(tweet.createdAt).valueOf()}-${tweet.id}`, {
        tweet,
        status: "pending",
      });
    }
  }

  async function cancelUploads() {
    if (!me) throw new Error("Account not initialised");
    me.root.uploadQueue = MediaUploadQueue.create({});
    isImporting = false;
  }

  async function uploadMediaFiles(
    uploadQueue: co.loaded<typeof MediaUploadQueue>,
    fileList: File[],
  ) {
    if (!isImporting) return; // don't do anything if user not ready
    console.log("processUploads: uploadQueue", uploadQueue);
    console.log("processUploads: fileList", fileList);

    async function uploadFile(path: string) {
      const file = uploadQueue[path];
      if (
        !file ||
        !UploadMedia.safeParse(file).success ||
        file.status !== "pending"
      ) {
        pushLog(
          "⚠️ Skipping file " +
            path +
            "with status " +
            (file?.status || "unknown"),
        );
        return;
      }
      pushLog("🌠 Uploading file " + path);
      file.status = "processing";
      console.log("file JSON", file.toJSON());
      const fileHandle = fileList.find(
        (f) => f.webkitRelativePath === file.path,
      );
      if (!fileHandle) {
        console.warn("File missing in folder", file.path);
        return;
      }
      try {
        let result;
        if (file.mediaType === "image") {
          result = await user.uploadBlob(fileHandle);
        } else if (file.mediaType === "video") {
          result = await user.uploadVideo(fileHandle);
        } else throw new Error("Unsupported media type");
        pushLog("✅ Uploaded file to " + result.url);
        file.url = result.url;
        file.status = "completed";
      } catch (error) {
        console.error("Error with file", file.toJSON(), error);
        pushLog("👎 Error uploading file at " + path);
        file.status = "failed";
      }
    }
    for (const path in uploadQueue) {
      await uploadFile(path);
    }
    me!.root!.uploadQueue = MediaUploadQueue.create({});
    pushLog("🌅 Finished uploading media!");
  }
</script>

<form class="pt-4 h-full">
  <div class="space-y-12">
    <h2 class="text-base/7 font-semibold text-base-900 dark:text-base-100">
      Twitter Import
    </h2>

    <p>
      To import your Twitter data, please download your data from X/Twitter and
      select the uncompressed folder containing the data.
    </p>

    {#if me?.root?.uploadQueue && Object.keys(me.root.uploadQueue).length > 0 && !isImporting}
      <Alert
        title={`There are ${Object.keys(me.root.uploadQueue).length} files in your upload queue.`}
      >
        <p>
          If your import was interrupted, select the same folder you selected
          previously and Resume, or Cancel to clear the queue.
        </p>
      </Alert>
    {/if}

    <div class="mt-10 grid grid-cols-1 gap-x-6 gap-y-8 sm:grid-cols-6">
      <div class="col-span-full">
        <label
          for="photo"
          class="block text-sm/6 font-medium text-base-900 dark:text-base-100"
          >Select Twitter Export Folder</label
        >
        <div class="mt-2 flex items-center gap-x-3">
          <input
            type="file"
            webkitdirectory
            multiple
            class="hidden"
            onchange={handleFolderSelect}
            bind:this={fileInput}
          />
          <Button variant="secondary" onclick={() => fileInput?.click()}
            >Select Folder</Button
          >
          {#if fileList}
            <p class="max-w-full truncate text-accent-500 font-medium">
              {fileList[0]?.webkitRelativePath.split("/")[0]}
            </p>
          {/if}
        </div>
        {#if fileList.length}
          <div class="mt-2">
            <p>{fileList.length} files found:</p>
            <p>&rarr; {mediaFiles.length} media files</p>
          </div>
        {/if}
        {#if importQueue && Object.keys(importQueue).length}
          <p class="mt-2">
            <strong class="text-accent-700"
              >{importQueue &&
                Object.values(importQueue).filter(
                  (f) => f?.status === "completed",
                ).length} out of {importQueue &&
                Object.keys(importQueue).length} files</strong
            > uploaded...
          </p>
        {/if}
      </div>
    </div>

    <div class="mt-6 flex items-center justify-end gap-x-6">
      <div>
        <Button
          type="button"
          disabled={!me?.root.uploadQueue ||
            Object.keys(me.root.uploadQueue).length == 0}
          onclick={cancelUploads}>Cancel</Button
        >
        <Button
          type="submit"
          disabled={isImporting || !fileList.length || isFinished}
          onclick={importTweets}
        >
          {#if isImporting}
            Importing...
          {:else if me?.root?.uploadQueue && Object.keys(me.root.uploadQueue).length}
            Resume
          {:else}
            Import
          {/if}
        </Button>
      </div>
    </div>
    <div class="mt-2 max-h-52 overflow-y-scroll" bind:this={container}>
      <ul>
        {#each logs as log}
          <li class="text-accent-500">{log}</li>
        {/each}
      </ul>
    </div>
  </div>
</form>
