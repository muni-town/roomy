<script lang="ts" module>
  export const threading = $state({
    active: false,
    selectedMessages: [] as string[],
  });
</script>

<script lang="ts">
  import toast from "svelte-french-toast";
  import { outerWidth } from "svelte/reactivity/window";

  import Icon from "@iconify/svelte";
  import ChatArea from "$lib/components/ChatArea.svelte";
  import ChatInput from "$lib/components/ChatInput.svelte";
  import { Button, Tabs } from "bits-ui";
  import { Account } from "jazz-tools";
  import { globalState } from "$lib/global.svelte";

  import { Message, RoomyAccount, Thread } from "$lib/jazz/schema";
  import TimelineToolbar from "$lib/components/TimelineToolbar.svelte";
  import CreatePageDialog from "$lib/components/CreatePageDialog.svelte";
  import BoardList from "./BoardList.svelte";
  import ToggleNavigation from "./ToggleNavigation.svelte";
  import { Index } from "flexsearch";
  import SearchResults from "./SearchResults.svelte";
  import type { Virtualizer } from "virtua/svelte";
  import { focusOnRender } from "$lib/actions/useFocusOnRender.svelte";
  import { AccountCoState, CoState } from "jazz-svelte";
  import { Channel, Space } from "$lib/jazz/schema";
  import { page } from "$app/state";
  import {
    createMessage,
    createThread,
    isSpaceAdmin,
    type ImageUrlEmbedCreate,
  } from "$lib/jazz/utils";
  import { extractTextContent } from "$lib/utils/extractText";
  import { user } from "$lib/user.svelte";
  import { replyTo } from "./ChatMessage.svelte";
  import MessageRepliedTo from "./Message/MessageRepliedTo.svelte";
  import { extractLinks } from "$lib/utils/collectLinks";
  import { untrack } from "svelte";
  import { addMessage, findMessages } from "$lib/search.svelte";
  import FullscreenImageDropper from "./helper/FullscreenImageDropper.svelte";
  import UploadFileButton from "./helper/UploadFileButton.svelte";

  let space = $derived(
    new CoState(Space, page.params.space, {
      resolve: {
        channels: {
          $each: true,
          $onError: null,
        },
        bans: {
          $each: true,
          $onError: null,
        },
      },
    }),
  );

  const links = $derived(
    space.current?.threads?.find((x) => x?.name === "@links"),
  );

  let admin = $derived(new CoState(Account, space.current?.adminId));

  let channel = $derived(
    new CoState(Channel, page.params.channel, {
      resolve: {
        mainThread: true,
        subThreads: true,
        pages: true,
      },
    }),
  );

  let thread = $derived(new CoState(Thread, page.params.thread));

  let timeline = $derived.by(() => {
    const currentTimeline =
      thread.current?.timeline ?? channel.current?.mainThread?.timeline;

    return Object.values(currentTimeline?.perAccount ?? {})
      .map((accountFeed) => new Array(...accountFeed.all))
      .flat()
      .sort((a, b) => a.madeAt.getTime() - b.madeAt.getTime())
      .map((a) => a.value);
  });

  let threadId = $derived(
    thread.current?.id ?? channel.current?.mainThread?.id,
  );

  $inspect(threadId).with(() => {
    console.log("threadId", threadId);
  });

  // $inspect(timeline).with(() => {
  //   console.log("timeline", timeline);
  // });

  const readonly = $derived(thread.current?.name === "@links");
  let isMobile = $derived((outerWidth.current ?? 0) < 640);

  let tab = $state<"chat" | "board">("chat");

  const me = new AccountCoState(RoomyAccount, {
    resolve: {
      profile: {
        joinedSpaces: true,
      },
    },
  });

  // Initialize tab based on hash if present
  // TODO: move this functionality to somewhere else
  // (not hash based, so we can actually move backwards with browser back button)
  // function updateTabFromHash() {
  //   const hash = window.location.hash.replace("#", "");
  //   if (hash === "chat" || hash === "board") {
  //     tab = hash as "chat" | "board";
  //   }
  // }

  // $effect(() => {
  //   updateTabFromHash();
  // });

  // // Update the hash when tab changes
  // $effect(() => {
  //   if (tab) {
  //     window.location.hash = tab;
  //   }
  // });

  let messageInput: string = $state("");

  // thread maker
  let threadTitleInput = $state("");

  // Initialize FlexSearch with appropriate options for message content
  let searchIndex = new Index({
    tokenize: "forward",
    preset: "performance",
  });
  let searchQuery = $state("");
  let showSearchInput = $state(false);
  let searchResults = $state([]);
  let showSearchResults = $state(false);
  let virtualizer = $state<Virtualizer<string> | undefined>(undefined);

  let filesInMessage: File[] = $state([]);

  // Function to handle search result click
  function handleSearchResultClick(messageId: string) {
    console.log("result clicked");
    // Hide search results
    showSearchResults = false;

    // Find the message in the timeline to get its index
    if (timeline) {
      // Get the timeline IDs - this returns an array, not a Promise
      const ids = timeline;

      if (!messageId.includes("co_")) {
        return;
      }

      const messageIndex = ids?.indexOf(messageId as `co_${string}`);
      console.log("message index", messageIndex);
      if (messageIndex !== -1) {
        virtualizer?.scrollToIndex(messageIndex);
      } else {
        console.error("Message not found in timeline:", messageId);
      }
    } else {
      console.error("No active channel");
    }
  }

  // Index existing messages when timeline items are loaded
  $effect(() => {
    if (searchIndex && globalState.channel?.messages) {
      const messages = globalState.channel?.messages;
      // items() returns a Promise, unlike ids() which returns an array directly
      // Clear index before re-indexing to avoid duplicates
      searchIndex.clear();
      if (messages) {
        for (const message of messages) {
          if (message) {
            // Try parsing the message body
            const parsedBody = JSON.parse(message.body);

            // Extract text content from the parsed body
            const textContent = extractTextContent(parsedBody);

            if (textContent) {
              searchIndex.add(message.id, textContent);
            }
          }
        }
      }
    }
  });

  $effect(() => {
    timeline;
    // const timeline = channel.current?.mainThread?.timeline;
    untrack(() => {
      console.log("timeline", timeline);
    });
  });

  async function addThread(e: SubmitEvent) {
    e.preventDefault();
    const messageIds = <string[]>[];

    // TODO: sort messages by their position/time created?

    for (const messageId of threading.selectedMessages) {
      messageIds.push(messageId);
      // remove from current thread timeline
      // add to message.hiddenIn
      const message = await Message.load(messageId, {
        resolve: {
          hiddenIn: true,
        },
      });
      if (!message) {
        console.error("Message not found", messageId);
        continue;
      }
      console.log("hiding message", messageId, threadId);
      if (threadId) {
        message.hiddenIn.push(threadId);
      }
      console.log("message hiddenIn", message.hiddenIn.toJSON());
    }

    // TODO: decide whether the thread needs a reference to it's original channel. That might be
    // confusing because it's messages could have come from multiple channels?

    let newThread = createThread(messageIds, threadTitleInput);

    console.log("pushing thread", newThread, space.current?.threads);
    space.current?.threads?.push(newThread);

    channel.current?.subThreads.push(newThread);
    threading.active = false;
    threading.selectedMessages = [];
    toast.success("Thread created", { position: "bottom-end" });
  }

  let isSendingMessage = $state(false);

  async function sendMessage() {
    if (!user.agent || !space.current) return;

    isSendingMessage = true;

    let filesUrls: ImageUrlEmbedCreate[] = [];
    // upload files
    for (const file of filesInMessage) {
      const uploadedFile = await user.uploadBlob(file);

      filesUrls.push({
        type: "imageUrl",
        data: {
          url: uploadedFile.url,
        },
      });
    }

    const message = createMessage(
      messageInput,
      undefined,
      admin.current || undefined,
      filesUrls,
    );

    let timeline =
      channel.current?.mainThread.timeline ?? thread.current?.timeline;
    if (timeline) {
      timeline.push(message.id);
    }
    if (replyTo.id) message.replyTo = replyTo.id;
    // addMessage(timeline?.id ?? "", message.id, messageInput);
    replyTo.id = "";

    if (links?.timeline) {
      const allLinks = extractLinks(messageInput);
      for (const link of allLinks) {
        const message = createMessage(
          `<a href="${link}">${link}</a>`,
          undefined,
          admin.current || undefined,
        );
        links.timeline.push(message.id);
      }
    }

    messageInput = "";
    for (let i = filesInMessage.length - 1; i >= 0; i--) {
      removeImageFile(i);
    }
    isSendingMessage = false;
  }

  // Handle search input
  $effect(() => {
    if (searchIndex && searchQuery) {
      // Perform synchronous search
      // const results = searchIndex.search(searchQuery);
      const results = findMessages(threadId ?? "", searchQuery);
      console.log("results", results, searchQuery);
      if (results.length > 0) {
        showSearchResults = true;
        // Get the actual Message objects for the search results
        searchResults = results;
      } else {
        searchResults = [];
        showSearchResults = searchQuery.length > 0;
      }
    } else {
      searchResults = [];
      showSearchResults = false;
    }
  });

  const pages = $derived(
    channel.current?.pages?.filter((page) => page && !page.softDeleted) || [],
  );

  const channelThreads = $derived(
    channel.current?.subThreads?.filter(
      (thread) => thread && !thread.softDeleted,
    ) || [],
  );

  function joinSpace() {
    if (!space.current || !me.current) return;

    // add to my list of joined spaces
    me.current?.profile?.joinedSpaces?.push(space.current);

    // add to space.current.members
    space.current?.members?.push(me.current);
  }

  let previewImages: string[] = $state([]);

  function processImageFile(file: File) {
    console.log("processing image file", file);
    filesInMessage.push(file);
    previewImages.push(URL.createObjectURL(file));
  }

  function removeImageFile(index: number) {
    let previewImage = previewImages[index];
    filesInMessage = filesInMessage.filter((_, i) => i !== index);
    previewImages = previewImages.filter((_, i) => i !== index);

    if (previewImage) {
      URL.revokeObjectURL(previewImage);
    }
  }

  let bannedHandles = $derived(new Set(space.current?.bans ?? []));

  $inspect(space.current?.members).with(() => {
    console.log("space.current?.members", space.current?.members?.toJSON());
  });
  let users = $derived(
    space.current?.members
      ?.map((member) => ({
        value: member?.id ?? "",
        label: member?.profile?.name ?? "",
      }))
      .filter((user) => user.value && user.label) || [],
  );

  let channels = $derived(
    space.current?.channels
      ?.map((channel) => ({
        value: JSON.stringify({
          id: channel?.id ?? "",
          space: space.current?.id ?? "",
          type: "channel",
        }),
        label: channel?.name ?? "",
        id: JSON.stringify({
          id: channel?.id ?? "",
          space: space.current?.id ?? "",
          type: "channel",
        }),
      }))
      .filter((channel) => channel.value && channel.label) || [],
  );
  let threads = $derived(
    space.current?.threads
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

  let context = $derived([...channels, ...threads]);
</script>

{#if admin.current}
  <div class="absolute top-0 left-0"></div>
{/if}

<header class="dz-navbar">
  <div class="dz-navbar-start flex gap-4">
    {#if channel.current}
      <ToggleNavigation />

      <h4
        class={`${isMobile && "line-clamp-1 overflow-hidden text-ellipsis"} text-base-content text-lg font-bold`}
        title={"Channel"}
      >
        <span class="flex gap-2 items-center">
          <Icon icon={"basil:comment-solid"} />
          {channel.current.name}
        </span>
      </h4>
    {/if}
  </div>

  {#if channel.current}
    <Tabs.Root
      bind:value={tab}
      class={isMobile ? "dz-navbar-end" : "dz-navbar-center"}
    >
      <Tabs.List class="dz-tabs dz-tabs-box">
        <Tabs.Trigger value="board" class="dz-tab flex gap-2">
          <Icon
            icon="tabler:clipboard-text{tab === 'board' ? '-filled' : ''}"
            class="text-2xl"
          />
          <p class="hidden sm:block">Board</p>
        </Tabs.Trigger>
        <Tabs.Trigger value="chat" class="dz-tab flex gap-2">
          <Icon
            icon="tabler:message{tab === 'chat' ? '-filled' : ''}"
            class="text-2xl"
          />
          <p class="hidden sm:block">Chat</p>
        </Tabs.Trigger>
      </Tabs.List>
    </Tabs.Root>
  {/if}

  {#if !isMobile}
    <div class="dz-navbar-end flex items-center gap-2">
      {#if tab === "chat"}
        <button
          class="btn btn-ghost btn-sm btn-circle"
          onclick={() => (showSearchInput = !showSearchInput)}
          title="Toggle search"
        >
          <Icon icon="tabler:search" class="text-base-content" />
        </button>
      {/if}
      <TimelineToolbar createThread={addThread} bind:threadTitleInput />
    </div>
  {/if}
</header>
<div class="divider my-0"></div>

{#if tab === "board"}
  <BoardList items={pages} title="Pages" route="page">
    {#snippet header()}
      <CreatePageDialog />
    {/snippet}
    No pages for this channel.
  </BoardList>
  <BoardList items={channelThreads} title="Threads" route="thread">
    No threads for this channel.
  </BoardList>
{:else if tab === "chat"}
  {#if space.current}
    <div class="flex flex-col h-[calc(100vh-124px)]">
      {#if showSearchInput}
        <div
          class="flex items-center border-b border-gray-200 dark:border-gray-700 px-2 py-1"
        >
          <Icon icon="tabler:search" class="text-base-content/50 mr-2" />
          <input
            type="text"
            placeholder="Search messages..."
            bind:value={searchQuery}
            use:focusOnRender
            class="input input-sm input-ghost w-full focus:outline-none"
            autoComplete="off"
          />
          <button
            class="btn btn-ghost btn-sm btn-circle"
            onclick={() => {
              searchQuery = "";
              showSearchInput = false;
              showSearchResults = false;
            }}
          >
            <Icon icon="tabler:x" class="text-base-content/50" />
          </button>
        </div>

        {#if showSearchResults}
          <div class="relative">
            <div class="absolute z-20 w-full">
              <SearchResults
                messages={searchResults}
                query={searchQuery}
                onMessageClick={handleSearchResultClick}
                onClose={() => {
                  showSearchResults = false;
                }}
              />
            </div>
          </div>
        {/if}
      {/if}
      <div class="flex-grow overflow-auto relative h-full">
        <ChatArea
          space={space.current}
          {timeline}
          bind:virtualizer
          isAdmin={isSpaceAdmin(space.current)}
          admin={admin.current}
          {threadId}
        />

        {#if replyTo.id}
          <div
            class="reply-container flex justify-between bg-secondary text-secondary-content rounded-t-lg px-4 py-2 absolute bottom-0 left-0 right-0"
          >
            <div class="flex items-center gap-1 overflow-hidden text-xs w-full">
              <span class="shrink-0">Replying to</span>
              <MessageRepliedTo messageId={replyTo.id} />
            </div>
            <Button.Root
              type="button"
              onclick={() => (replyTo.id = "")}
              class="dz-btn dz-btn-circle dz-btn-ghost flex-shrink-0"
            >
              <Icon icon="zondicons:close-solid" />
            </Button.Root>
          </div>
        {/if}
      </div>

      <div>
        {#if !isMobile || !threading.active}
          <div>
            {#if user.session}
              {#if me?.current?.profile?.joinedSpaces?.some((joinedSpace) => joinedSpace?.id === space.current?.id)}
                {#if readonly}
                  <div class="flex items-center grow flex-col">
                    <Button.Root disabled class="w-full dz-btn"
                      >Automated Thread</Button.Root
                    >
                  </div>
                {:else if !bannedHandles.has(me?.current?.profile?.blueskyHandle ?? "")}
                  <div
                    class="dz-prose prose-a:text-primary prose-a:underline relative isolate"
                  >
                    {#if previewImages.length > 0}
                      <div class="flex gap-2 my-2 overflow-x-auto w-full">
                        {#each previewImages as previewImage, index (previewImage)}
                          <div class="size-24 relative shrink-0">
                            <img
                              src={previewImage}
                              alt="Preview"
                              class="absolute inset-0 w-full h-full object-cover"
                            />

                            <button
                              class="btn btn-ghost btn-sm btn-circle absolute p-0.5 top-1 right-1 bg-base-100 rounded-full"
                              onclick={() => removeImageFile(index)}
                            >
                              <Icon icon="tabler:x" class="size-4" />
                            </button>
                          </div>
                        {/each}
                      </div>
                    {/if}

                    <div class="flex gap-1 w-full">
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
                          <span
                            class="dz-loading dz-loading-spinner mx-auto w-8"
                          ></span>
                        </div>
                      </div>
                    {/if}
                  </div>
                {:else}
                  <div class="flex items-center grow flex-col">
                    <Button.Root disabled class="w-full dz-btn"
                      >You are banned from this space</Button.Root
                    >
                  </div>
                {/if}
              {:else}
                <div class="flex items-center grow flex-col">
                  <Button.Root onclick={joinSpace} class="w-full dz-btn"
                    >Join this space to chat</Button.Root
                  >
                </div>
              {/if}
            {:else}
              <Button.Root
                class="w-full dz-btn"
                onclick={() => {
                  user.isLoginDialogOpen = true;
                }}>Login to Chat</Button.Root
              >
            {/if}
          </div>
        {/if}

        {#if isMobile}
          <!-- <TimelineToolbar {createThread} bind:threadTitleInput /> -->
        {/if}
      </div>
    </div>
  {/if}
{/if}

<style>
  .reply-highlight {
    animation: pulse-highlight 2s ease-in-out;
  }

  @keyframes pulse-highlight {
    0% {
      background-color: rgba(59, 130, 246, 0.1);
      box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2);
    }
    50% {
      background-color: rgba(59, 130, 246, 0.2);
      box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.3);
    }
    100% {
      background-color: transparent;
      box-shadow: none;
    }
  }

  /* Same style for search result highlight for consistency */
  .search-result-highlight {
    animation: pulse-highlight 2s ease-in-out;
  }
</style>
