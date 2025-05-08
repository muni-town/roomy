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

  import { derivePromise } from "$lib/utils.svelte";
  import { globalState } from "$lib/global.svelte";
  import {
    Announcement,
    Channel,
    Message,
    Thread,
    Timeline,
    Category,
  } from "@roomy-chat/sdk";
  import type { JSONContent } from "@tiptap/core";
  import { getProfile } from "$lib/profile.svelte";
  import TimelineToolbar from "$lib/components/TimelineToolbar.svelte";
  import CreatePageDialog from "$lib/components/CreatePageDialog.svelte";
  import BoardList from "./BoardList.svelte";
  import ToggleNavigation from "./ToggleNavigation.svelte";

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
  setContext("removeSelectedMessage", (message: Message) => {
    selectedMessages = selectedMessages.filter((m) => m != message);
  });

  $effect(() => {
    if (!isThreading.value && selectedMessages.length > 0) {
      selectedMessages = [];
    }
  });

  // Reply Utils
  let replyingTo = $state() as Message | undefined;
  setContext("setReplyTo", (message: Message) => {
    replyingTo = message;
  });

  async function createThread(e: SubmitEvent) {
    e.preventDefault();
    if (!globalState.roomy || !globalState.space || !globalState.channel)
      return;

    const thread = await globalState.roomy.create(Thread);

    // messages can be selected in any order
    // sort them on create based on their position from the channel
    let channelMessageIds = globalState.channel.timeline.ids();
    selectedMessages.sort((a, b) => {
      return channelMessageIds.indexOf(a.id) - channelMessageIds.indexOf(b.id);
    });

    for (const message of selectedMessages) {
      // move selected message ID from channel to thread timeline
      thread.timeline.push(message);
      const index = globalState.channel.timeline.ids().indexOf(message.id);
      globalState.channel.timeline.remove(index);

      // create an Announcement about the move for each message
      const announcement = await globalState.roomy.create(Announcement);
      announcement.kind = "messageMoved";
      announcement.relatedMessages.push(message);
      announcement.relatedThreads.push(thread);
      announcement.commit();
      globalState.channel.timeline.insert(index, announcement);
    }

    // TODO: decide whether the thread needs a reference to it's original channel. That might be
    // confusing because it's messages could have come from multiple channels?
    thread.name = threadTitleInput;
    thread.commit();

    // create an Announcement about the new Thread in current channel
    const announcement = await globalState.roomy.create(Announcement);
    announcement.kind = "threadCreated";
    announcement.relatedThreads.push(thread);
    announcement.commit();

    globalState.channel.timeline.push(announcement);

    // If this is a channel ( the alternative would be a thread )
    if (globalState.channel instanceof Channel) {
      globalState.channel.threads.push(thread);
    }

    globalState.channel.commit();

    globalState.space.threads.push(thread);
    globalState.space.commit();

    threadTitleInput = "";
    isThreading.value = false;
    toast.success("Thread created", { position: "bottom-end" });
  }

  async function sendMessage() {
    if (
      !globalState.roomy ||
      !globalState.space ||
      !globalState.channel ||
      !user.agent
    )
      return;

    // Image upload is now handled in ChatInput.svelte

    const message = await globalState.roomy.create(Message);
    message.authors(
      (authors) => user.agent && authors.push(user.agent.assertDid),
    );
    message.bodyJson = JSON.stringify(messageInput);
    message.createdDate = new Date();
    message.commit();
    if (replyingTo) message.replyTo = replyingTo;

    // Images are now handled by TipTap in the message content
    // Limit image size in message input to 300x300

    globalState.channel.timeline.push(message);
    globalState.channel.commit();

    messageInput = {};
    replyingTo = undefined;
  }

  //
  // Settings Dialog
  //

  $effect(() => {
    if (!globalState.space) return;

    globalState.space &&
      globalState.space.sidebarItems.items().then((items) => {
        for (const item of items) {
          const category = item.tryCast(Category);
          if (
            category &&
            typeof category.channels === "object" &&
            typeof category.channels.ids === "function" &&
            globalState.channel &&
            category.channels.ids().includes(globalState.channel.id)
          ) {
            return;
          }
        }
      });
  });
  // Image upload is now handled in ChatInput.svelte
  let relatedThreads = derivePromise([], async () =>
    globalState.channel && globalState.channel instanceof Channel
      ? await globalState.channel.threads.items()
      : [],
  );
  const pages = derivePromise([], async () => {
    return globalState.space && globalState.channel instanceof Channel
      ? (await globalState.channel.wikipages.items()).filter(
          (x) => !x.softDeleted,
        )
      : [];
  });
</script>

<header class="dz-navbar">
  <div class="dz-navbar-start flex gap-4">
    {#if globalState.channel}
      <ToggleNavigation />

      <h4
        class={`${isMobile && "line-clamp-1 overflow-hidden text-ellipsis"} text-base-content text-lg font-bold`}
        title={globalState.channel instanceof Channel ? "Channel" : "Thread"}
      >
        <span class="flex gap-2 items-center">
          <Icon
            icon={globalState.channel instanceof Channel
              ? "basil:comment-solid"
              : "material-symbols:thread-unread-rounded"}
          />
          {globalState.channel.name}
        </span>
      </h4>
    {/if}
  </div>

  {#if globalState.channel instanceof Channel}
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
    <div class="dz-navbar-end">
      <TimelineToolbar {createThread} bind:threadTitleInput />
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
  <BoardList items={relatedThreads.value} title="Topics" route="thread">
    No topics for this channel.
  </BoardList>
{:else if tab === "chat" || globalState.channel instanceof Thread}
  {#if globalState.space && globalState.channel}
    <ChatArea timeline={globalState.channel.forceCast(Timeline)} />
    <div class="flex items-center">
      {#if !isMobile || !isThreading.value}
        <section class="grow flex flex-col">
          {#if replyingTo}
            <div
              class="flex justify-between bg-secondary text-secondary-content rounded-t-lg px-4 py-2"
            >
              <div class="flex flex-col gap-1">
                <h5 class="flex gap-2 items-center">
                  Replying to
                  {#await getProfile(replyingTo.authors( (x) => x.get(0), )) then profile}
                    <AvatarImage
                      handle={profile.handle || ""}
                      avatarUrl={profile.avatarUrl}
                      className="!w-4"
                    />
                    <strong>{profile.handle}</strong>
                  {/await}
                </h5>
                <p class="text-primary-content text-ellipsis italic">
                  {@html getContentHtml(JSON.parse(replyingTo.bodyJson))}
                </p>
              </div>
              <Button.Root
                type="button"
                onclick={() => (replyingTo = undefined)}
                class="dz-btn dz-btn-circle dz-btn-ghost"
              >
                <Icon icon="zondicons:close-solid" />
              </Button.Root>
            </div>
          {/if}
          <div class="relative">
            <!-- TODO: get all users that has joined the server -->
            {#if globalState.roomy && globalState.roomy.spaces
                .ids()
                .includes(globalState.space.id)}
              <ChatInput
                bind:content={messageInput}
                users={users.value}
                context={contextItems.value}
                onEnter={sendMessage}
              />
            {:else}
              <Button.Root
                class="w-full dz-btn"
                onclick={() => {
                  if (globalState.space && globalState.roomy) {
                    globalState.roomy.spaces.push(globalState.space);
                    globalState.roomy.commit();
                  }
                }}>join Space To Chat</Button.Root
              >
            {/if}

            <!-- Image upload button is now in ChatInput.svelte -->
          </div>
        </section>
      {/if}

      {#if isMobile}
        <TimelineToolbar {createThread} bind:threadTitleInput />
      {/if}
    </div>
  {/if}
{/if}
