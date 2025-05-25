<script lang="ts">
  import { getContext, setContext } from "svelte";
  import toast from "svelte-french-toast";
  import { user } from "$lib/user.svelte";
  import { getContentHtml, type Item } from "$lib/tiptap/editor";
  import { outerWidth } from "svelte/reactivity/window";

  import Icon from "@iconify/svelte";
  import ChatArea from "$lib/components/ChatArea.svelte";
  import ChatInput from "$lib/components/ChatInput.svelte";
  import AvatarImage from "$lib/components/AvatarImage.svelte";
  import { Button, Tabs } from "bits-ui";
import {co,z} from "jazz-tools"
  import { derivePromise } from "$lib/utils.svelte";
  import { collectLinks, tiptapJsontoString } from "$lib/utils/collectLinks";
  import { globalState } from "$lib/global.svelte";
  // import {
  //   Announcement,
  //   Channel,
  //   Message,
  //   Thread,
  //   Timeline,
  // } from "@roomy-chat/sdk";
  import { Channel, Message, Messages, Profile } from "$lib/schema";
  import type { JSONContent } from "@tiptap/core";
  import { getProfile } from "$lib/profile.svelte";
  import TimelineToolbar from "$lib/components/TimelineToolbar.svelte";
  import CreatePageDialog from "$lib/components/CreatePageDialog.svelte";
  import BoardList from "./BoardList.svelte";
  import ToggleNavigation from "./ToggleNavigation.svelte";
  import { Index } from "flexsearch";
  import SearchResults from "./SearchResults.svelte";
  import type { Virtualizer } from "virtua/svelte";
  import { focusOnRender } from "$lib/actions/useFocusOnRender.svelte";

  let messages = $derived(globalState.channel?.messages)

  // Helper function to extract text content from TipTap JSON content
  function extractTextContent(parsedBody: Record<string, unknown>): string {
    if (
      !parsedBody ||
      typeof parsedBody !== "object" ||
      !("content" in parsedBody)
    )
      return "";

    let text = "";

    // Process the content recursively to extract text
    function processNode(node: Record<string, unknown>): void {
      if ("text" in node && typeof node.text === "string") {
        text = `${text}${node.text} `;
      }

      if ("content" in node && Array.isArray(node.content)) {
        for (const item of node.content) {
          if (typeof item === "object" && item !== null) {
            processNode(item as Record<string, unknown>);
          }
        }
      }
    }

    // Start processing from the root content
    if ("content" in parsedBody && Array.isArray(parsedBody.content)) {
      for (const node of parsedBody.content) {
        if (typeof node === "object" && node !== null) {
          processNode(node as Record<string, unknown>);
        }
      }
    }

    return text.trim();
  }

  // const links = derivePromise(null, async () =>
  //   (await globalState.space?.threads.items())?.find(
  //     (x) => x.name === "@links",
  //   ),
  // );
  const readonly = $derived(globalState.channel?.name === "@links");
  let isMobile = $derived((outerWidth.current ?? 0) < 640);

  let users: { value: Item[] } = getContext("users");
  let contextItems: { value: Item[] } = getContext("contextItems");

  let tab = $state<"chat" | "board">("chat");

  // Initialize tab based on hash if present
  function updateTabFromHash() {
    const hash = window.location.hash.replace("#", "");
    if (hash === "chat" || hash === "board") {
      tab = hash as "chat" | "board";
    }
  }

  $effect(() => {
    updateTabFromHash();
  });

  // Update the hash when tab changes
  $effect(() => {
    if (tab) {
      window.location.hash = tab;
    }
  });

  let messageInput: JSONContent = $state({});

  // thread maker
  let isThreading = $state({ value: false });
  let threadTitleInput = $state("");
  let selectedMessages: Message[] = $state([]);
  setContext("isThreading", isThreading);
  setContext("selectMessage", (message: Message) => {
    selectedMessages.push(message);
  });
  setContext("removeSelectedMessage", (msg: Message) => {
    selectedMessages = selectedMessages.filter((m) => m !== msg);
  });

  $effect(() => {
    if (!isThreading.value && selectedMessages.length > 0) {
      selectedMessages = [];
    }
  });

  // Reply Utils
  let replyingTo = $state<Message>();
  setContext("setReplyTo", (message: Message) => {
    replyingTo = message;
  });

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
    // Hide search results
    showSearchResults = false;

    // Find the message in the timeline to get its index
    if (globalState.channel?.messages) {
      // Get the timeline IDs - this returns an array, not a Promise
      const ids = globalState.channel?.messages?.map((message) => message?.id);

      if (!messageId.includes("co_  ")) {
        return;
      }

      const messageIndex = ids?.indexOf(messageId as `co_${string}`);

      if (messageIndex && messageIndex !== -1) {
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

  // async function createThread(e: SubmitEvent) {
  //   e.preventDefault();
  //   if (!globalState.space || !globalState.channel)
  //     return;

  //   const thread = await globalState.roomy.create(Thread);

  //   // messages can be selected in any order
  //   // sort them on create based on their position from the channel
  //   let channelMessageIds = globalState.channel.timeline.ids();
  //   selectedMessages.sort((a, b) => {
  //     return channelMessageIds.indexOf(a.id) - channelMessageIds.indexOf(b.id);
  //   });

  //   for (const message of selectedMessages) {
  //     // move selected message ID from channel to thread timeline
  //     thread.timeline.push(message);
  //     const index = globalState.channel.timeline.ids().indexOf(message.id);
  //     globalState.channel.timeline.remove(index);

  //     // create an Announcement about the move for each message
  //     const announcement = await globalState.roomy.create(Announcement);
  //     announcement.kind = "messageMoved";
  //     announcement.relatedMessages.push(message);
  //     announcement.relatedThreads.push(thread);
  //     announcement.commit();
  //     globalState.channel.timeline.insert(index, announcement);
  //   }

  //   // TODO: decide whether the thread needs a reference to it's original channel. That might be
  //   // confusing because it's messages could have come from multiple channels?
  //   thread.name = threadTitleInput;
  //   thread.commit();

  //   // create an Announcement about the new Thread in current channel
  //   const announcement = await globalState.roomy.create(Announcement);
  //   announcement.kind = "threadCreated";
  //   announcement.relatedThreads.push(thread);
  //   announcement.commit();

  //   globalState.channel.timeline.push(announcement);

  //   // If this is a channel ( the alternative would be a thread )
  //   if (globalState.channel instanceof Channel) {
  //     globalState.channel.threads.push(thread);
  //   }

  //   globalState.channel.commit();

  //   globalState.space.threads.push(thread);
  //   globalState.space.commit();

  //   threadTitleInput = "";
  //   isThreading.value = false;
  //   toast.success("Thread created", { position: "bottom-end" });
  // }

  async function sendMessage() {
    if (!globalState.space || !globalState.channel || !user.agent) return;

    // Image upload is now handled in ChatInput.svelte
    console.log("creating message", JSON.stringify(messageInput))
    const did = user.agent.did;
    if(!did){
      throw "missing did from agent"
    }
    const profileMeta = await getProfile(did);
    // const profileMeta = {
    //   handle: "",
    //   displayName: "",
    //   avatarUrl: "",
    // }
    const profile = Profile.create({
      handle: profileMeta.handle,
      displayName: profileMeta.displayName || "",
      avatarUrl: profileMeta.avatarUrl,
    })
    const message = Message.create({
      body: JSON.stringify(messageInput),
      profile,
    });
    console.log("ACCOUNT", globalState.account.current)
    // console.log(message.toJSON())
    // if (replyingTo) message.replyTo = replyingTo;

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
    if (collectLinks(tiptapJsontoString(messageInput))) {
      // if (links.value) {
      //   links.value.timeline.push(message);
      //   links.value.commit();
      // }
    }
    const messages = globalState.channel.messages || co.list(Message).create([])
    console.log("messs", messages.toJSON())
    messages.push(message)
    globalState.channel.messages = messages
    // const holder = globalState.channel.messages;
    // globalState.channel.messages = co.list(z.string()).create([]);
    const channel = await Channel.load(globalState.channel.id, {resolve: {messages: {$each: true}}})
    console.log("channel?", channel.toJSON())
    globalState.channel = channel
    messageInput = {};
    replyingTo = undefined;
  }

  // Handle search input
  $effect(() => {
    if (searchIndex && searchQuery) {
      // Perform synchronous search
      const results = searchIndex.search(searchQuery);

      if (results.length > 0) {
        showSearchResults = true;

        // Get the actual Message objects for the search results
        if (globalState.channel.messages) {
          const messages = globalState.channel.messages;
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

  // let relatedThreads = derivePromise([], async () =>
  //   globalState.channel && globalState.channel instanceof Channel
  //     ? await globalState.channel.threads.items()
  //     : [],
  // );

  // const pages = derivePromise([], async () => {
  //   return globalState.space && globalState.channel instanceof Channel
  //     ? (await globalState.channel.wikipages.items()).filter(
  //         (x) => !x.softDeleted,
  //       )
  //     : [];
  // });
</script>

<header class="dz-navbar">
  <div class="dz-navbar-start flex gap-4">
    {#if globalState.channel}
      <ToggleNavigation />

      <h4
        class={`${isMobile && "line-clamp-1 overflow-hidden text-ellipsis"} text-base-content text-lg font-bold`}
        title={"Channel"}
      >
        <span class="flex gap-2 items-center">
          <Icon
            icon={"basil:comment-solid"}
          />
          {globalState.channel.name}
        </span>
      </h4>
    {/if}
  </div>

  {#if globalState.channel}
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
      <!-- <TimelineToolbar {createThread} bind:threadTitleInput /> -->
    </div>
  {/if}
</header>
<div class="divider my-0"></div>

{#if tab === "board"}
  <BoardList items={pages.value} title="Pages" route="page">
    {#snippet header()}
      <CreatePageDialog />
    {/snippet}
    No pages for this channel.
  </BoardList>
  <!-- <BoardList items={relatedThreads.value} title="Threads" route="thread">
    No threads for this channel.
  </BoardList> -->
{:else if tab === "chat"}
  {#if globalState.space && globalState.channel}
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
          timeline={messages}
          bind:virtualizer
        />

        {#if replyingTo}
          <div
            class="reply-container flex justify-between bg-secondary text-secondary-content rounded-t-lg px-4 py-2 absolute bottom-0 left-0 right-0"
          >
            <div class="flex items-center gap-2 overflow-hidden">
              <span>Replying to</span>
              <!-- {#await getProfile(replyingTo.authors( (x) => x.get(0), )) then profile}
                <AvatarImage
                  handle={profile.handle || ""}
                  avatarUrl={profile.avatarUrl}
                  className="!w-4"
                />
                <strong>{profile.handle}</strong>
              {/await} -->
              <p
                class="text-primary-content text-ellipsis italic max-h-12 overflow-hidden ml-2 contain-images-within"
              >
                {@html getContentHtml(JSON.parse(replyingTo.body))}
              </p>
            </div>
            <Button.Root
              type="button"
              onclick={() => (replyingTo = undefined)}
              class="dz-btn dz-btn-circle dz-btn-ghost flex-shrink-0"
            >
              <Icon icon="zondicons:close-solid" />
            </Button.Root>
          </div>
        {/if}
      </div>

      <div>
        {#if !isMobile || !isThreading.value}
          <div class="chat-input-container">
            {#if true}
              {#if !readonly}
                <ChatInput
                  bind:content={messageInput}
                  users={[]}
                  context={[]}
                  onEnter={sendMessage}
                />
              {:else}
                <div class="flex items-center grow flex-col">
                  <Button.Root disabled class="w-full dz-btn"
                    >Automatted Thread</Button.Root
                  >
                </div>
              {/if}
            {:else}
              <Button.Root
                class="w-full dz-btn"
                onclick={() => {
                  // if (globalState.space && globalState.roomy) {
                  //   globalState.roomy.spaces.push(globalState.space);
                  //   globalState.roomy.commit();
                  // }
                }}>Join Space To Chat</Button.Root
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
