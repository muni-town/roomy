<script lang="ts">
  import _ from "underscore";
  import { page } from "$app/state";
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

  import { navigate } from "$lib/utils.svelte";
  import { g } from "$lib/global.svelte";
  import {
    Announcement,
    Channel,
    Message,
    Thread,
    Timeline,
  } from "@roomy-chat/sdk";
  import type { JSONContent } from "@tiptap/core";
  import { getProfile } from "$lib/profile.svelte";
  import WikiEditor from "$lib/components/WikiEditor.svelte";
  import TimelineToolbar from "$lib/components/TimelineToolbar.svelte";
  import ThreadsTab from "$lib/components/ThreadsTab.svelte";

  let isMobile = $derived((outerWidth.current ?? 0) < 640);

  let users: { value: Item[] } = getContext("users");
  let contextItems: { value: Item[] } = getContext("contextItems");

  let tab = $state<"chat" | "board">("board");

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
    if (!g.roomy || !g.space || !g.channel) return;

    const thread = await g.roomy.create(Thread);

    // messages can be selected in any order
    // sort them on create based on their position from the channel
    let channelMessageIds = g.channel.timeline.ids();
    selectedMessages.sort((a, b) => {
      return channelMessageIds.indexOf(a.id) - channelMessageIds.indexOf(b.id);
    });

    for (const message of selectedMessages) {
      // move selected message ID from channel to thread timeline
      thread.timeline.push(message);
      const index = g.channel.timeline.ids().indexOf(message.id);
      g.channel.timeline.remove(index);

      // create an Announcement about the move for each message
      const announcement = await g.roomy.create(Announcement);
      announcement.kind = "messageMoved";
      announcement.relatedMessages.push(message);
      announcement.relatedThreads.push(thread);
      announcement.commit();
      g.channel.timeline.insert(index, announcement);
    }

    // TODO: decide whether the thread needs a reference to it's original channel. That might be
    // confusing because it's messages could have come from multiple channels?
    thread.name = threadTitleInput;
    thread.commit();

    // create an Announcement about the new Thread in current channel
    const announcement = await g.roomy.create(Announcement);
    announcement.kind = "threadCreated";
    announcement.relatedThreads.push(thread);
    announcement.commit();

    g.channel.timeline.push(announcement);

    // If this is a channel ( the alternative would be a thread )
    if (g.channel instanceof Channel) {
      g.channel.threads.push(thread);
    }

    g.channel.commit();

    g.space.threads.push(thread);
    g.space.commit();

    threadTitleInput = "";
    isThreading.value = false;
    toast.success("Thread created", { position: "bottom-end" });
  }

  async function sendMessage() {
    if (!g.roomy || !g.space || !g.channel || !user.agent) return;

    /* TODO: image upload refactor with tiptap
    const images = imageFiles
      ? await Promise.all(
          Array.from(imageFiles).map(async (file) => {
            try {
              const resp = await user.uploadBlob(file);
              return {
                source: resp.url, // Use the blob reference from ATP
                alt: file.name,
              };
            } catch (error) {
              console.error("Failed to upload image:", error);
              toast.error("Failed to upload image", { position: "bottom-end" });
              return null;
            }
          }),
        ).then((results) =>
          results.filter(
            (result): result is NonNullable<typeof result> => result !== null,
          ),
        )
      : undefined;
    */

    const message = await g.roomy.create(Message);
    message.authors(
      (authors) => user.agent && authors.push(user.agent.assertDid),
    );
    message.bodyJson = JSON.stringify(messageInput);
    message.createdDate = new Date();
    message.commit();
    if (replyingTo) message.replyTo = replyingTo;

    // TODO: image upload refactor with tiptap

    g.channel.timeline.push(message);
    g.channel.commit();

    messageInput = {};
    replyingTo = undefined;
  }

  //
  // Settings Dialog
  //

  /* TODO: image upload refactor with tiptap
  let mayUploadImages = $derived.by(() => {
    if (isAdmin) return true;
    if (!space) { return }

    let messagesByUser = Object.values(space.view.messages).filter(
      (x) => user.agent && x.author == user.agent.assertDid,
    );
    if (messagesByUser.length > 5) return true;
    return !!messagesByUser.find(
      (message) =>
        !!Object.values(message.reactions).find(
          (reactedUsers) =>
            !!reactedUsers.find((user) => !!space?.view.admins.includes(user)),
        ),
    );
  });
  */

  /* TODO: image upload refactor with tiptap
  async function handleImageSelect(event: Event) {
    const input = event.target as HTMLInputElement;
    imageFiles = input.files;
  }

  async function handlePaste(event: ClipboardEvent) {
    if (!mayUploadImages) return;

    const items = event.clipboardData?.items;
    if (!items) return;

    for (const item of items) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          imageFiles = new DataTransfer().files;
          const dataTransfer = new DataTransfer();
          dataTransfer.items.add(file);
          imageFiles = dataTransfer.files;
        }
      }
    }
  }
  */
</script>

<header class="navbar">
  <div class="navbar-start flex gap-4">
    {#if g.channel}
      <label
        for="sidebar-left"
        class="btn btn-ghost p-1 shrink-0 drawer-button sm:hidden"
        title="Open sidebar"
      >
        <Icon icon="basil:menu-outline" font-size="1.75rem" />
      </label>

      <h4
        class={`${isMobile && "line-clamp-1 overflow-hidden text-ellipsis"} text-base-content text-lg font-bold`}
        title={g.channel instanceof Channel ? "Channel" : "Thread"}
      >
        <span class="flex gap-2 items-center">
          <Icon
            icon={g.channel instanceof Channel
              ? "basil:comment-solid"
              : "material-symbols:thread-unread-rounded"}
          />
          {g.channel.name}
        </span>
      </h4>
    {/if}
  </div>

  {#if g.channel instanceof Channel}
    <Tabs.Root
      bind:value={tab}
      class={isMobile ? "navbar-end" : "navbar-center"}
    >
      <Tabs.List class="tabs tabs-box">
        <Tabs.Trigger value="board" class="tab flex gap-2">
          <Icon icon="tabler:clipboard" class="text-2xl" />
          {#if !isMobile}
            <p>Board</p>
          {/if}
        </Tabs.Trigger>
        <Tabs.Trigger value="chat" class="tab flex gap-2">
          <Icon icon="tabler:message" class="text-2xl" />
          {#if !isMobile}
            <p>Chat</p>
          {/if}
        </Tabs.Trigger>
      </Tabs.List>
    </Tabs.Root>
  {/if}

  {#if !isMobile}
    <div class="navbar-end">
      <TimelineToolbar {createThread} bind:threadTitleInput />
    </div>
  {/if}
</header>
<div class="divider my-0"></div>

{#if tab === "board"}
  <ThreadsTab />
  <WikiEditor />
{:else if tab === "chat" || g.channel instanceof Thread}
  {#if g.space && g.channel}
    <ChatArea timeline={g.channel.forceCast(Timeline)} />
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
                <p class="text-gray-300 text-ellipsis italic">
                  {@html getContentHtml(JSON.parse(replyingTo.bodyJson))}
                </p>
              </div>
              <Button.Root
                type="button"
                onclick={() => (replyingTo = undefined)}
                class="btn btn-circle btn-ghost"
              >
                <Icon icon="zondicons:close-solid" />
              </Button.Root>
            </div>
          {/if}
          <div class="relative">
            <!-- TODO: get all users that has joined the server -->
            {#if g.roomy && g.roomy.spaces.ids().includes(g.space.id)}
              <ChatInput
                bind:content={messageInput}
                users={users.value}
                context={contextItems.value}
                onEnter={sendMessage}
              />
            {:else}
              <Button.Root
                class="w-full btn"
                onclick={() => {
                  if (g.space && g.roomy) {
                    g.roomy.spaces.push(g.space);
                    g.roomy.commit();
                  }
                }}>Join Space To Chat</Button.Root
              >
            {/if}

            <!--
            {#if mayUploadImages}
              <label
                class="cursor-pointer text-white hover:text-gray-300 absolute right-3 top-1/2 -translate-y-1/2"
              >
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  class="hidden"
                  onchange={handleImageSelect}
                />
                <Icon
                  icon="material-symbols:add-photo-alternate"
                  class="text-2xl"
                />
              </label>
            {/if}
            -->
          </div>

          <!-- Image preview
          {#if imageFiles?.length}
            <div class="flex gap-2 flex-wrap">
              {#each Array.from(imageFiles) as file}
                <div class="relative mt-5">
                  <img
                    src={URL.createObjectURL(file)}
                    alt={file.name}
                    class="w-20 h-20 object-cover rounded"
                  />
                  <button
                    type="button"
                    class="absolute -top-2 -right-2 bg-red-500 rounded-full p-1"
                    onclick={() => (imageFiles = null)}
                  >
                    <Icon icon="zondicons:close-solid" color="white" />
                  </button>
                </div>
              {/each}
            </div>
          {/if}
          -->
        </section>
      {/if}

      {#if isMobile}
        <TimelineToolbar {createThread} bind:threadTitleInput />
      {/if}
    </div>
  {/if}
{/if}
