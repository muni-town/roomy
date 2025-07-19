<script lang="ts">
  import toast from "svelte-french-toast";
  import Icon from "@iconify/svelte";
  import ChatArea from "$lib/components/ChatArea.svelte";
  import ChatInput from "$lib/components/ChatInput.svelte";
  import { Button } from "@fuxui/base";
  import { co } from "jazz-tools";
  import {
    LastReadList,
    Message,
    RoomyAccount,
    RoomyEntity,
    addToInbox,
    createMessage,
    createThread,
    isSpaceAdmin,
    type ImageUrlEmbedCreate,
    type VideoUrlEmbedCreate,
    AllThreadsComponent,
    ThreadComponent,
    SpacePermissionsComponent,
    BansComponent,
    SubThreadsComponent,
    AllMembersComponent,
  } from "@roomy-chat/sdk";
  import { AccountCoState, CoState } from "jazz-tools/svelte";
  import { user } from "$lib/user.svelte";
  import { replyTo } from "./message/ChatMessage.svelte";
  import MessageRepliedTo from "./message/MessageRepliedTo.svelte";
  import { extractLinks } from "$lib/utils/collectLinks";
  import FullscreenImageDropper from "./helper/FullscreenImageDropper.svelte";
  import UploadFileButton from "./helper/UploadFileButton.svelte";
  import { afterNavigate } from "$app/navigation";
  import { blueskyLoginModalState } from "@fuxui/social";
  import { joinSpace } from "./helper/joinSpace";
  import FullscreenImage from "./helper/FullscreenImage.svelte";

  // Component-level threading state - scoped per channel
  let threading = $state({
    active: false,
    selectedMessages: [] as string[],
  });

  let { objectId, spaceId }: { objectId: string; spaceId: string } = $props();

  let space = $derived(
    new CoState(RoomyEntity, spaceId, {
      resolve: {
        components: {
          $each: true,
          $onError: null,
        },
      },
    }),
  );

  let permissions = $derived(
    new CoState(
      SpacePermissionsComponent.schema,
      space.current?.components?.[SpacePermissionsComponent.id],
    ),
  );

  let threadObject = $derived(
    new CoState(RoomyEntity, objectId, {
      resolve: {
        components: {
          $each: true,
          $onError: null,
        },
      },
    }),
  );

  let threadContent = $derived(
    new CoState(
      ThreadComponent.schema,
      threadObject.current?.components?.[ThreadComponent.id],
    ),
  );

  let timeline = $derived.by(() => {
    const currentTimeline = threadContent.current?.timeline;

    return Object.values(currentTimeline?.perAccount ?? {})
      .map((accountFeed) => new Array(...accountFeed.all))
      .flat()
      .sort((a, b) => a.madeAt.getTime() - b.madeAt.getTime())
      .map((a) => a.value);
  });

  let threadId = $derived(threadObject.current?.id);

  const me = new AccountCoState(RoomyAccount, {
    resolve: {
      profile: {
        newJoinedSpacesTest: true,
      },
    },
  });

  function setLastRead() {
    if (!me?.current?.root) return;

    if (me?.current?.root?.lastRead === null) {
      me.current.root.lastRead = LastReadList.create({});
    }

    if (objectId && me.current.root.lastRead) {
      me.current.root.lastRead[objectId] = new Date();
    }
  }

  function getVideoThumbnail(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const video = document.createElement("video");
      video.src = URL.createObjectURL(file);
      video.crossOrigin = "anonymous";
      video.muted = true; // required for autoplay
      video.currentTime = 0;

      video.addEventListener("loadeddata", () => {
        // Wait until some data is loaded so we can capture a frame
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth / 2; // scale it down
        canvas.height = video.videoHeight / 2;

        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("Canvas context not available"));

        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => {
          if (!blob)
            return reject(new Error("Failed to create thumbnail blob"));
          const url = URL.createObjectURL(blob);
          resolve(url);
        }, "image/jpeg");
      });

      video.addEventListener("error", reject);
    });
  }

  let messageInput: string = $state("");

  // thread maker
  let threadTitleInput = $state("");

  let filesInMessage: File[] = $state([]);

  // @ts-ignore Temporary until threads are added back
  async function handleCreateThread(e: SubmitEvent) {
    e.preventDefault();
    const messageIds = <string[]>[];

    const sortedMessages = threading.selectedMessages
      .map((messageId) => {
        const messageIndex = timeline.findIndex(
          (message) => message === messageId,
        );
        return [messageId, messageIndex] as [string, number];
      })
      .sort((a, b) => a[1] - b[1]);

    let firstMessage: co.loaded<typeof Message> | undefined = undefined;

    for (const [messageId, _] of sortedMessages) {
      messageIds.push(messageId);

      const message = await Message.load(messageId, {
        resolve: {
          hiddenIn: true,
        },
      });
      if (!message) {
        console.error("Message not found when creating thread", messageId);
        continue;
      }
      // hide all messages except the first message in original thread
      if (firstMessage) {
        if (threadId) message.hiddenIn.push(threadId);
      } else {
        firstMessage = message;
      }
    }

    let newThread = await createThread(threadTitleInput, permissions.current!);

    // add all messages to the new thread
    for (const messageId of messageIds) {
      newThread.thread.timeline.push(messageId);
    }

    if (firstMessage) {
      firstMessage.threadId = newThread.roomyObject.id;
    }

    const allThreadsId = space.current?.components?.[AllThreadsComponent.id];
    if (allThreadsId) {
      const allThreads = await AllThreadsComponent.schema.load(allThreadsId);
      allThreads?.push(newThread.roomyObject);
    }

    const subThreadsId = threadObject.current?.components?.[SubThreadsComponent.id];
    if (subThreadsId) {
      const subThreads = await SubThreadsComponent.schema.load(subThreadsId);
      subThreads?.push(newThread.roomyObject);
    }

    threading.active = false;
    threading.selectedMessages = [];
    toast.success("Thread created", { position: "bottom-end" });
  }

  let isSendingMessage = $state(false);

  const notifications = $derived(
    me.current?.profile?.roomyInbox?.filter(
      (x) => x && x.objectId === objectId && !x.read,
    ),
  );

  $effect(() => {
    if (notifications && notifications.length > 0) {
      // remove those from the inbox
      for (
        let i = (me.current?.profile?.roomyInbox?.length ?? 0) - 1;
        i >= 0;
        i--
      ) {
        const item = me.current?.profile?.roomyInbox?.[i];
        if (item?.objectId === objectId && !item?.read) {
          item.read = true;
        }
      }
    }
  });

  async function sendMessage() {
    if (!user.agent || !space.current) return;

    console.log(messageInput);
    if (messageInput.trim() === "<p> </p>" && filesInMessage.length === 0) {
      toast.error("Please enter a message");
      return;
    }

    isSendingMessage = true;

    let filesUrls: (ImageUrlEmbedCreate | VideoUrlEmbedCreate)[] = [];
    // upload files
    for (const file of filesInMessage) {
      if (file.type.startsWith("video/")) {
        const uploadedFile = await user.uploadVideo(file);
        filesUrls.push({
          type: "videoUrl",
          data: {
            url: uploadedFile.url,
          },
        });
      } else {
        const uploadedFile = await user.uploadBlob(file);
        filesUrls.push({
          type: "imageUrl",
          data: {
            url: uploadedFile.url,
          },
        });
      }
    }

    console.log("permissions", permissions.current);
    if (!permissions.current) {
      toast.error("You are not allowed to send messages in this space");
      isSendingMessage = false;
      return;
    }

    const message = await createMessage(
      messageInput,
      undefined,
      filesUrls,
      permissions.current,
    );

    let timeline = threadContent.current?.timeline;
    if (timeline) {
      console.log("pushing message to timeline", message.id);
      timeline.push(message.id);
    }
    if (replyTo.id) {
      message.replyTo = replyTo.id;
      const replyToMessage = await Message.load(replyTo.id);
      const userId = replyToMessage?._edits?.content?.by?.id;
      if (userId) {
        addToInbox(
          userId,
          "reply",
          message.id,
          space.current?.id ?? "",
          objectId,
        );
      }
    }
    replyTo.id = "";

    // see if we mentioned anyone (all links that start with /user/)
    const allLinks = extractLinks(messageInput);
    for (const link of allLinks) {
      if (link.startsWith("/user/")) {
        const userId = link.split("/")[2];
        console.log("mentioned user", userId);
        if (!userId) continue;

        addToInbox(
          userId,
          "mention",
          message.id,
          space.current?.id ?? "",
          objectId,
        );
      }
    }

    messageInput = "";
    for (let i = filesInMessage.length - 1; i >= 0; i--) {
      removeImageFile(i);
    }
    isSendingMessage = false;
  }

  afterNavigate(() => {
    count = timeline.length ?? 0;
  });

  // svelte-ignore state_referenced_locally
  let count = $state(timeline.length ?? 0);

  $effect(() => {
    let newCount = timeline?.length ?? 0;
    if (count < newCount) {
      count = newCount;
      setLastRead();
    }
  });

  let previewImages: string[] = $state([]);

  function processImageFile(file: File) {
    filesInMessage.push(file);

    if (file.type.startsWith("video/")) {
      getVideoThumbnail(file).then((thumbnail) => {
        previewImages.push(thumbnail);
      });
    } else {
      previewImages.push(URL.createObjectURL(file));
    }
  }

  function removeImageFile(index: number) {
    let previewImage = previewImages[index];
    filesInMessage = filesInMessage.filter((_, i) => i !== index);
    previewImages = previewImages.filter((_, i) => i !== index);

    if (previewImage) {
      URL.revokeObjectURL(previewImage);
    }
  }

  let bannedAccounts = $derived(new CoState(BansComponent.schema, space.current?.components?.[BansComponent.id]));
  let bannedAccountsSet = $derived(new Set(bannedAccounts.current?.map((ban) => ban)));

  let members = $derived(
    new CoState(AllMembersComponent.schema, space.current?.components?.[AllMembersComponent.id]),
  );

  let users = $derived(
    Object.values(members.current?.perAccount ?? {})
      .map((accountFeed) => new Array(...accountFeed.all))
      .flat()
      .sort((a, b) => a.madeAt.getTime() - b.madeAt.getTime())
      .map((a) => a.value)
      .filter((a) => a && !a.softDeleted)
      .map((a) => ({
        value: a?.account?.id ?? "",
        label: a?.account?.profile?.name ?? "",
      })) || [],
  );

  const threadFeed = $derived(
    new CoState(
      AllThreadsComponent.schema,
      space.current?.components?.[AllThreadsComponent.id],
    ),
  );

  let threads = $derived(
    Object.values(threadFeed.current?.perAccount ?? {})
      .map((accountFeed) => new Array(...accountFeed.all))
      .flat()
      .sort((a, b) => a.madeAt.getTime() - b.madeAt.getTime())
      .map((a) => a.value)
      ?.map((thread) => ({
        value: JSON.stringify({
          id: thread?.id ?? "",
          space: space.current?.id ?? "",
          type: "thread",
        }),
        label: thread?.name ?? "",
      }))
      .filter((thread) => thread.value && thread.label) || [],
  );
  let context = $derived([...threads]);

  let hasJoinedSpace = $derived(
    me.current?.profile?.newJoinedSpacesTest?.some(
      (joinedSpace) => joinedSpace?.id === space.current?.id,
    ),
  );

  let isBanned = $derived(bannedAccountsSet.has(me.current?.id ?? ""));
</script>

<!-- hack to get the admin to load ^^ it has to be used somewhere in this file -->
{#if permissions.current}
  <div class="absolute top-0 left-0"></div>
{/if}

{#if space.current}
  <div class="flex flex-col flex-1 overflow-hidden">
    <div class="flex-1 overflow-y-auto overflow-x-hidden relative">
      <ChatArea
        space={space.current}
        {timeline}
        isAdmin={isSpaceAdmin(space.current)}
        {threadId}
        allowedToInteract={hasJoinedSpace && !isBanned}
        {threading}
      />
    </div>

    <div
      class="flex-none bg-white dark:bg-base-950 pt-2 pb-2 pr-2 border-t border-base-100 dark:border-base-900"
    >
      {#if replyTo.id}
        <div
          class="flex justify-between bg-secondary text-secondary-content rounded-t-lg px-4 py-2"
        >
          <div class="flex items-center gap-1 overflow-hidden text-xs w-full">
            <span class="shrink-0 text-base-900 dark:text-base-100"
              >Replying to</span
            >
            <MessageRepliedTo messageId={replyTo.id} />
          </div>
          <Button
            variant="ghost"
            onclick={() => (replyTo.id = "")}
            class="flex-shrink-0"
          >
            <Icon icon="zondicons:close-solid" />
          </Button>
        </div>
      {/if}
      <div class="w-full py-1">
        {#if user.session}
          {#if hasJoinedSpace}
            {#if !isBanned}
              <div
                class="prose-a:text-primary prose-a:underline relative isolate"
              >
                {#if previewImages.length > 0}
                  <div class="flex gap-2 my-2 overflow-x-auto w-full px-2">
                    {#each previewImages as previewImage, index (previewImage)}
                      <div class="size-24 relative shrink-0">
                        <img
                          src={previewImage}
                          alt="Preview"
                          class="absolute inset-0 w-full h-full object-cover"
                        />

                        <Button
                          variant="ghost"
                          class="absolute p-0.5 top-1 right-1 bg-base-100 hover:bg-base-200 dark:bg-base-900 dark:hover:bg-base-800 rounded-full"
                          onclick={() => removeImageFile(index)}
                        >
                          <Icon icon="tabler:x" class="size-4" />
                        </Button>
                      </div>
                    {/each}
                  </div>
                {/if}

                <div class="flex w-full pl-2 gap-2">
                  <UploadFileButton {processImageFile} />

                  {#key users.length + context.length}
                    <ChatInput
                      bind:content={messageInput}
                      {users}
                      {context}
                      onEnter={sendMessage}
                      {processImageFile}
                    />
                  {/key}
                </div>
                <FullscreenImageDropper {processImageFile} />

                {#if isSendingMessage}
                  <div
                    class="absolute inset-0 flex items-center text-primary justify-center z-20 bg-base-100/80"
                  >
                    <div class="text-xl font-bold flex items-center gap-4">
                      Sending message...
                      <span class="dz-loading dz-loading-spinner mx-auto w-8"
                      ></span>
                    </div>
                  </div>
                {/if}
              </div>
            {:else}
              <div class="flex items-center grow flex-col px-4">
                <Button disabled class="w-full max-w-xl"
                  >You are banned from this space</Button
                >
              </div>
            {/if}
          {:else}
            <div class="flex items-center grow flex-col px-4">
              <Button
                onclick={() => joinSpace(space.current, me.current)}
                class="w-full max-w-xl">Join this space to chat</Button
              >
            </div>
          {/if}
        {:else}
          <div class="flex items-center grow flex-col">
            <Button
              onclick={() => {
                blueskyLoginModalState.show();
              }}>Login to Chat</Button
            >
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}

<FullscreenImage />
