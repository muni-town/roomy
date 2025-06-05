<script lang="ts">
  import { setContext } from "svelte";
  import toast from "svelte-french-toast";
  import { outerWidth } from "svelte/reactivity/window";

  import Icon from "@iconify/svelte";
  import ChatArea from "$lib/components/ChatArea.svelte";
  import ChatInput from "$lib/components/ChatInput.svelte";
  import { Button, Tabs } from "bits-ui";
  import { Account } from "jazz-tools";
  import { globalState } from "$lib/global.svelte";

  import { RoomyAccount, Thread } from "$lib/jazz/schema";
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
  import { createMessage, createThread, isSpaceAdmin } from "$lib/jazz/utils";
  import { extractTextContent } from "$lib/utils/extractText";
  import { user } from "$lib/user.svelte";
  import { replyTo } from "./ChatMessage.svelte";
  import MessageRepliedTo from "./Message/MessageRepliedTo.svelte";
  import { extractLinks } from "$lib/utils/collectLinks";

  // const links = derivePromise(null, async () =>
  //   (await globalState.space?.threads.items())?.find(
  //     (x) => x.name === "@links",
  //   ),
  // );

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
  $inspect(timeline).with(() => {
    console.log("timeline", timeline);
  });

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
  let isThreading = $state({ value: false });
  let threadTitleInput = $state("");

  setContext("isThreading", isThreading);

  // Initialize FlexSearch with appropriate options for message content
  let searchIndex = new Index({
    tokenize: "forward",
    preset: "performance",
  });
  let searchQuery = $state("");
  let showSearchInput = $state(false);
  let searchResults = $state<Message[]>([]);
  let showSearchResults = $state(false);
  let virtualizer = $state<Virtualizer<string> | undefined>(undefined);

  // Function to handle search result click
  function handleSearchResultClick(messageId: string) {
    console.log("result clicked");
    // Hide search results
    showSearchResults = false;

    // Find the message in the timeline to get its index
    if (globalState.channel?.messages) {
      // Get the timeline IDs - this returns an array, not a Promise
      const ids = globalState.channel?.messages?.map((message) => message?.id);

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

  async function addThread(e: SubmitEvent) {
    e.preventDefault();
    console.log("creating thread");
    // if (!globalState.space || !globalState.channel) return;
    // thread.messages = co.list(Message).create([]);
    // messages can be selected in any order
    // sort them on create based on their position from the channel
    // let channelMessageIds =
    //   globalState.channel.messages
    //     ?.filter((message) => message !== null)
    //     .map((message) => message.id) || [];
    // selectedMessages.sort((a, b) => {
    //   return channelMessageIds.indexOf(a.id) - channelMessageIds.indexOf(b.id);
    // });
    // if (!globalState.space.threads) {
    //   globalState.space.threads = co.list(Thread).create([]);
    // }
    const messageIds = <string[]>[];
    // for (const message of selectedMessages) {
    //   // move selected message ID from channel to thread timeline
    //   messageIds.push(message.id);
    //   // thread.timeline.push(message.id);
    //   // const index = globalState.channel.messages.ids().indexOf(message.id);
    //   // globalState.channel.messages.remove(index);

    //   // create an Announcement about the move for each message
    //   // const announcement = await globalState.roomy.create(Announcement);
    //   // announcement.kind = "messageMoved";
    //   // announcement.relatedMessages.push(message);
    //   // announcement.relatedThreads.push(thread);
    //   // announcement.commit();
    //   // globalState.channel.timeline.insert(index, announcement);
    // }
    let thread = createThread(messageIds, threadTitleInput);

    console.log("pushing thread", thread, space.current?.threads);
    space.current?.threads?.push(thread);

    // TODO: decide whether the thread needs a reference to it's original channel. That might be
    // // confusing because it's messages could have come from multiple channels?
    // thread.name = threadTitleInput;
    // thread.commit();

    channel.current?.subThreads.push(thread);
    isThreading.value = false;
    toast.success("Thread created", { position: "bottom-end" });
  }

  async function sendMessage() {
    console.log("sending message", space.current, channel.current);

    // maybe add back in later (if we only want to allow people signed in with bluesky to send messages)
    //if (!user.agent) return;

    // Image upload is now handled in ChatInput.svelte
    console.log("creating message", messageInput, admin.current);

    const message = createMessage(
      messageInput,
      undefined,
      admin.current || undefined,
    );
    if (channel.current?.mainThread.timeline) {
      channel.current.mainThread.timeline.push(message.id);
    }
    if (thread.current?.timeline) {
      thread.current.timeline.push(message.id);
    }
    if (replyTo.id) message.replyTo = replyTo.id;

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

    // Add new message to search index
    // if (searchIndex) {
    //   const parsedBody = JSON.parse(message.body);

    //   // Extract text content from the parsed body
    //   const textContent = extractTextContent(parsedBody);

    //   if (textContent) {
    //     searchIndex.add(message.id, textContent);
    //   }
    // }

    // Images are now handled by TipTap in the message content
    // Limit image size in message input to 300x300
    // if (collectLinks(tiptapJsontoString(messageInput))) {
    // if (links.value) {
    //   links.value.timeline.push(message);
    //   links.value.commit();
    // }
    // }
    messageInput = "";
  }

  // Handle search input
  $effect(() => {
    if (searchIndex && searchQuery) {
      // Perform synchronous search
      const results = searchIndex.search(searchQuery);

      if (results.length > 0) {
        showSearchResults = true;
        // Get the actual Message objects for the search results
        if (timeline) {
          const messages = timeline.items();
          searchResults = messages.filter(
            (msg): msg is Message =>
              msg !== null && msg !== undefined && results.includes(msg.id),
          );
        }
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

  const threads = $derived(
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

  let bannedHandles = $derived(new Set(space.current?.bans ?? []));
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
  <BoardList items={threads} title="Threads" route="thread">
    No threads for this channel.
  </BoardList>
{:else if tab === "chat"}
  {#if space.current}
    <div class="flex h-full flex-col">
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
      <div
        class="flex-grow overflow-auto relative"
        style="max-height: calc(100vh - 180px);"
      >
        <ChatArea
          space={space.current}
          {timeline}
          bind:virtualizer
          isAdmin={isSpaceAdmin(space.current)}
          admin={admin.current}
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
        {#if !isMobile || !isThreading.value}
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
                  <div class="dz-prose prose-a:text-primary prose-a:underline">
                    <ChatInput
                      bind:content={messageInput}
                      users={[]}
                      context={[]}
                      onEnter={sendMessage}
                    />
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
