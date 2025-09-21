<script lang="ts">
  import toast from "svelte-french-toast";
  import ChatArea from "$lib/components/content/thread/ChatArea.svelte";
  import ChatInput from "$lib/components/content/thread/ChatInput.svelte";
  import { Button, Input } from "@fuxui/base";
  import { setInputFocus } from "./ChatInput.svelte";
  import { replyTo } from "./message/ChatMessage.svelte";
  import MessageRepliedTo from "./message/MessageRepliedTo.svelte";
  import { extractLinks } from "$lib/utils/collectLinks";
  import FullscreenImageDropper from "$lib/components/helper/FullscreenImageDropper.svelte";
  import UploadFileButton from "$lib/components/helper/UploadFileButton.svelte";
  import { afterNavigate } from "$app/navigation";
  import { blueskyLoginModalState } from "@fuxui/social";
  import FullscreenImage from "$lib/components/helper/FullscreenImage.svelte";
  import WaitingForJoinModal from "$lib/components/modals/WaitingForJoinModal.svelte";

  let threading = $state({
    active: false,
    selectedMessages: [] as string[],
    name: "",
  });

  let { objectId, spaceId }: { objectId: string; spaceId: string } = $props();

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

  let filesInMessage: File[] = $state([]);

  function startThreading(id?: string) {
    threading.active = true;
    id && threading.selectedMessages.push(id);
    setInputFocus();
  }

  function toggleSelect(id: string) {
    const index = threading?.selectedMessages.indexOf(id) ?? -1;
    if (index > -1) {
      threading?.selectedMessages.splice(index, 1);
    } else {
      threading?.selectedMessages.push(id);
    }
  }

  // @ts-ignore
  async function handleCreateThread(e: SubmitEvent) {
    e.preventDefault();
    const messageIds = <string[]>[];

    if (!space.current) return;
    const groups = await getSpaceGroups(space.current);

    const sortedMessages = threading.selectedMessages
      .map((messageId) => {
        const messageIndex = timeline.findIndex(
          (message) => message === messageId,
        );
        return [messageId, messageIndex] as [string, number];
      })
      .sort((a, b) => a[1] - b[1]);

    let firstMessage: co.loaded<typeof RoomyEntity> | undefined = undefined;

    for (const [messageId, _] of sortedMessages) {
      messageIds.push(messageId);

      const message = await RoomyEntity.load(messageId, {
        resolve: {
          components: {
            $each: true,
          },
        },
      });
      if (!message) {
        console.error("Message not found when creating thread", messageId);
        continue;
      }
      const hiddenIn = await HiddenInComponent.load(
        message.components[HiddenInComponent.id] || "",
      );
      // hide all messages except the first message in original thread
      if (firstMessage) {
        if (threadId) hiddenIn?.hiddenIn?.push(threadId);
      } else {
        firstMessage = message;
      }
    }

    if (
      !firstMessage ||
      !firstMessage.components ||
      !firstMessage.components[CommonMarkContentComponent.id]
    )
      throw new Error("No components found on first message");

    const firstMessageContent = await CommonMarkContentComponent.load(
      firstMessage.components[CommonMarkContentComponent.id]!,
    );

    let newThreadName = threading.name || firstMessageContent?.content;

    if (!newThreadName) throw new Error("No thread name");

    // TODO: fix this hack
    if (newThreadName.includes("<p>"))
      newThreadName = newThreadName.split("<p>")[1]!;
    if (newThreadName.includes("</p>"))
      newThreadName = newThreadName.split("</p>")[0]!;

    let { entity, thread } = await createThread(newThreadName, groups);

    // add all messages to the new thread
    for (const messageId of messageIds) {
      thread.timeline.push(messageId);
    }

    if (firstMessage && firstMessage.components) {
      firstMessage.components[BranchThreadIdComponent.id] = entity.id;
    }

    const allThreadsId = space.current.components[AllThreadsComponent.id];
    if (allThreadsId) {
      const allThreads = await AllThreadsComponent.load(allThreadsId);
      allThreads?.push(entity);
    }

    const subThreadsId =
      threadObject.current?.components?.[SubThreadsComponent.id];
    if (subThreadsId) {
      const subThreads = await SubThreadsComponent.load(subThreadsId);
      subThreads?.push(entity);
    }

    console.log("Created Subthread", entity.id);

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
    const group = await getUserSpaceGroup(space.current);
    const { entity: message } = await createMessage(messageInput, group, {
      embeds: filesUrls,
    });

    let timeline = threadContent.current?.timeline;
    if (timeline) {
      console.log("pushing message to timeline", message.id);
      timeline.push(message.id);
    }
    if (replyTo.id) {
      message.components[ReplyToComponent.id] = replyTo.id;
      const replyToMessage = await RoomyEntity.load(replyTo.id);
      const userId = replyToMessage?._edits?.components?.by?.id;
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

  let members = $derived(
    new CoState(
      AllMembersComponent,
      space.current?.components?.[AllMembersComponent.id],
      {
        resolve: {
          $each: {
            account: {
              profile: {
                $onError: null,
              },
            },
          },
          $onError: null,
        },
      },
    ),
  );

  let users = $derived(
    Object.values(members.current?.perAccount ?? {})
      .filter(
        (a) =>
          a && !bannedAccountsSet.has(a.by?.id ?? "") && !a.value?.softDeleted,
      )
      .flat()
      .map((a) => ({
        value: a?.value?.account?.id ?? "",
        label: a?.value?.account?.profile?.name ?? "",
      })) || [],
  );

  $inspect(users);

  const threadFeed = $derived(
    new CoState(
      AllThreadsComponent,
      space.current?.components?.[AllThreadsComponent.id],
    ),
  );

  let threads = $derived(
    Object.values(threadFeed.current?.perAccount ?? {})
      .map((accountFeed) => new Array(...accountFeed.all))
      .flat()
      .sort((a, b) => a.madeAt.getTime() - b.madeAt.getTime())
      .map((a) => a.value)
      .filter((thread) => !thread?.softDeleted)
      .map((thread) => ({
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
    me.current?.profile?.joinedSpaces?.some(
      (joinedSpace) => joinedSpace?.id === space.current?.id,
    ),
  );

  let isBanned = $derived(bannedAccountsSet.has(me.current?.id ?? ""));

  let waitingForJoin = $state(false);
</script>

{#if space.current}
  <div class="flex flex-col flex-1 overflow-hidden">
    <div class="flex-1 overflow-y-auto overflow-x-hidden relative">
      <ChatArea
        space={space.current}
        {timeline}
        {isAdmin}
        {threadId}
        allowedToInteract={hasJoinedSpace && !isBanned}
        {threading}
        {startThreading}
        {toggleSelect}
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
      {#if threading.active}
        <div
          class="flex items-start justify-between bg-secondary text-secondary-content rounded-t-lg px-2 py-2"
        >
          <div
            class="px-2 flex flex-wrap items-center gap-1 overflow-hidden text-xs w-full"
          >
            <span class="shrink-0 text-base-900 dark:text-base-100"
              >Creating thread with</span
            >
            {#if threading.selectedMessages[0]}
              <div class="max-w-[28rem]">
                <MessageRepliedTo messageId={threading.selectedMessages[0]} />
              </div>
            {/if}
            {#if threading.selectedMessages.length > 1}
              <span class="shrink-0 text-base-900 dark:text-base-100"
                >and {threading.selectedMessages.length - 1} other message{threading
                  .selectedMessages.length > 2
                  ? "s"
                  : ""}</span
              >
            {:else if threading.selectedMessages.length === 0}
              <span class="shrink-0 text-base-900 dark:text-base-100"
                >no messages</span
              >
            {/if}
          </div>
          <Button
            variant="ghost"
            onclick={() => {
              threading.active = false;
              threading.selectedMessages = [];
            }}
            class="flex-shrink-0"
          >
            <Icon icon="zondicons:close-solid" />
          </Button>
        </div>
        <label for="thread-name" class="px-4 py-2 text-xs font-medium"
          >Thread name (optional):</label
        >
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
                  {#if threading.active}
                    <form onsubmit={handleCreateThread}>
                      <Input
                        bind:value={threading.name}
                        id="thread-name"
                        class="grow ml-2"
                      />
                      <Button type="submit"
                        ><Icon icon="tabler:needle-thread" />Create
                        <span class="hidden sm:inline-block sm:-ml-1"
                          >Thread</span
                        ></Button
                      >
                    </form>
                  {:else}
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
                  {/if}
                </div>
                <FullscreenImageDropper {processImageFile} />

                {#if isSendingMessage}
                  <div
                    class="absolute inset-0 flex items-center text-primary justify-center z-20 bg-base-100/80 dark:bg-base-900/80"
                  >
                    <div
                      class="text-xl font-bold flex items-center gap-4 text-base-900 dark:text-base-100"
                    >
                      Sending message...
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
                onclick={async () => {
                  waitingForJoin = true;
                  await joinSpace(space.current, me.current);
                  waitingForJoin = false;
                }}
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

<WaitingForJoinModal bind:open={waitingForJoin} />
