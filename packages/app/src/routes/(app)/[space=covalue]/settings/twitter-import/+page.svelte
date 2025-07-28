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
    createMessage,
    createThread,
    MediaUploadQueue,
    RoomyAccount,
    RoomyEntity,
    SpacePermissionsComponent,
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

  let isImporting = $state(false);
  let fileList = $state<File[]>([]);
  let tweetsQueue = $state<Map<string, QueuedTweet>>(new Map());
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

  let tweetsJs = $derived(
    fileList.find((file) => file.webkitRelativePath.includes("tweets.js")),
  );
  let tweetsPart1js = $derived(
    fileList.find((file) =>
      file.webkitRelativePath.includes("tweets-part1.js"),
    ),
  );

  let mediaFiles = $derived(
    fileList.filter((file) =>
      file.webkitRelativePath.includes("/tweets_media/"),
    ),
  );

  let fileInput = $state<HTMLInputElement | null>(null);
  let logs = $state<string[]>([]);
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
  /**
   * First we need to upload all the media. This means putting all the media uploads into a persistent queue.
   * This is the 'uploadQueue' on the user account root.
   * It also might be good to have a clear estimate of how much data that will be.
   */

  async function importTweets() {
    if (isImporting) return;
    try {
      if (!space.current) throw new Error("No current space");
      isImporting = true;

      await me?.root.ensureLoaded({ resolve: { uploadQueue: true } });
      // Populate the upload queue

      console.log("UploadQueue", me?.root.uploadQueue);

      if (!me) throw new Error("Account not loaded");
      if (!me.root.uploadQueue)
        me.root.uploadQueue = MediaUploadQueue.create({});
      const uploadQueue = me.root.uploadQueue;

      mediaFiles.forEach((file) => {
        uploadQueue[file.webkitRelativePath] = UploadMedia.create({
          path: file.webkitRelativePath,
          mediaType: file.type.startsWith("video") ? "video" : "image",
          status: "pending",
        });
      });

      pushLog("📤 Queued " + Object.keys(uploadQueue).length + " uploads");

      await uploadMediaFiles(uploadQueue, fileList);

      // Then, create a channel
      if (!permissions.current) throw new Error("no permissions");
      let newChannel = await createThread(
        "Twitter Import",
        permissions.current!,
      );
      if (!space.current) throw new Error("no space found");
      if (!newChannel) throw new Error("channel could not be created");
      if (!uploadQueue) throw new Error("no upload queue");
      addToFolder(space.current!, newChannel.roomyObject);

      allThreads.current?.push(newChannel.roomyObject);

      // get the timeline for the thread
      if (!newChannel.roomyObject.components[ThreadComponent.id])
        throw new Error("No thread in thread");
      const threadContent = await ThreadContent.load(
        newChannel.roomyObject.components[ThreadComponent.id]!,
        {
          resolve: {
            timeline: true,
          },
        },
      );
      if (!threadContent) throw new Error("no thread content");
      let timeline = threadContent?.timeline;

      pushLog("🌱 Channel created: Twitter Import.");

      pushLog("📚 Organising tweets into thread...");

      // sort tweets by the unix timestamp in the key
      const prefixInt = (s: string) => parseInt(s.split(":")[0]!, 10);
      let tweetKeys = [...tweetsQueue.keys()].sort(
        (a, b) => prefixInt(a) - prefixInt(b),
      );
      // Then, post each tweet into the channel with the relevant file attached
      const postTweet = async (key: string) => {
        const tweet = tweetsQueue.get(key);
        if (!tweet) return;

        // for each one, we have to get the URL for any attached media
        const uploadMediaUrls = Object.keys(uploadQueue!).filter(
          (path) => tweet.tweet.id && path.includes(tweet.tweet.id),
        );
        const uploadMedia = uploadMediaUrls.map((key) => uploadQueue![key]);

        const uploadedMediaUrls = uploadMedia
          .filter((m) => m && m?.url)
          .map((m) => m!.url!);

        // and then, post the message in the channel
        const messageText = tweet.tweet.text;

        let fileUrlEmbeds: (ImageUrlEmbedCreate | VideoUrlEmbedCreate)[] = [];
        // upload files
        for (const url of uploadedMediaUrls) {
          fileUrlEmbeds.push({
            type: "imageUrl",
            data: {
              url,
            },
          });
        }

        const message = await createMessage(messageText, {
          permissions: permissions.current || undefined,
          embeds: fileUrlEmbeds,
          created: new Date(tweet.tweet.createdAt),
        });
        timeline.push(message.id);
      };
      for (const key of tweetKeys) {
        await postTweet(key);
      }
      pushLog(
        "🎉 Finished Importing Tweets! Go to the 'Twitter Import' channel to see them.",
      );
      toast.success(
        "🎉 Finished Importing Tweets! Go to the 'Twitter Import' channel to see them.",
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
  }

  async function handleFolderSelect(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      console.log(input.files);
      fileList = Array.from(input.files ?? []);
    }
  }

  $effect(() => {
    if (tweetsJs) {
      tweetsJs.text().then((text) => parseTweets(text, 0));
    }

    if (tweetsPart1js) {
      tweetsPart1js.text().then((text) => parseTweets(text, 1));
    }
  });

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
        const result = await user.uploadBlob(fileHandle);
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
            > uploaded.
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
          disabled={isImporting || !fileList.length}
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
    <div class="mt-2 max-h-52 overflow-y-scroll">
      <ul>
        {#each logs as log}
          <li class="text-accent-500">{log}</li>
        {/each}
      </ul>
    </div>
  </div>
</form>
