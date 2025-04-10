<script lang="ts">
  import _ from "underscore";
  import { page } from "$app/state";
  import { getContext, setContext, untrack, onMount, onDestroy } from "svelte";
  import toast from "svelte-french-toast";
  import { user } from "$lib/user.svelte";
  import { getContentHtml, type Item } from "$lib/tiptap/editor";
  import { outerWidth } from "svelte/reactivity/window";
  import { networkStatus, attemptReconnect } from "$lib/network-status.svelte";

  import Icon from "@iconify/svelte";
  import Dialog from "$lib/components/Dialog.svelte";
  import ChatArea from "$lib/components/ChatArea.svelte";
  import ChatInput from "$lib/components/ChatInput.svelte";
  import AvatarImage from "$lib/components/AvatarImage.svelte";
  import { Button, Popover, Tabs } from "bits-ui";

  import { format, isToday } from "date-fns";
  import { derivePromise, navigate } from "$lib/utils.svelte";
  import { g } from "$lib/global.svelte";
  import {
    Announcement,
    Category,
    Channel,
    Message,
    Thread,
    Timeline,
  } from "@roomy-chat/sdk";
  import type { JSONContent } from "@tiptap/core";
  import { getProfile } from "$lib/profile.svelte";
  import WikiEditor from "./WikiEditor.svelte";

  let isMobile = $derived((outerWidth.current ?? 0) < 640);

  let users: { value: Item[] } = getContext("users");
  let contextItems: { value: Item[] } = getContext("contextItems");
  let relatedThreads = derivePromise([], async () =>
    g.channel && g.channel instanceof Channel
      ? await g.channel.threads.items()
      : [],
  );

  let tab = $state<"chat" | "threads" | "wiki">("chat");

  // Initialize tab based on hash if present
  function updateTabFromHash() {
    const hash = window.location.hash.replace("#", "");
    if (hash === "chat" || hash === "threads" || hash === "wiki") {
      tab = hash as "chat" | "threads" | "wiki";
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
    selectedMessages = selectedMessages.filter((m) => m !== message);
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

  // Function to get the profile of the user being replied to
  async function getReplyingToProfile() {
    if (!replyingTo) return { handle: 'unknown', avatarUrl: '' };

    try {
      // Try to get the author ID using various methods
      let authorId = null;

      if (typeof replyingTo.authors === 'function') {
        authorId = replyingTo.authors((x) => x.get(0));
      } else {
        // Fallback to any available method
        const msgAny = replyingTo as unknown as Record<string, any>;
        if (msgAny.author) {
          authorId = msgAny.author;
        } else if (msgAny._data?.author) {
          authorId = msgAny._data.author;
        }
      }

      if (!authorId) {
        console.warn('Could not find author ID for reply message');
        return { handle: 'unknown', avatarUrl: '' };
      }

      // Get the profile using the author ID
      return await getProfile(authorId);
    } catch (error) {
      console.error('Error getting reply profile:', error);
      return { handle: 'unknown', avatarUrl: '' };
    }
  }

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

  // Track pending messages that need to be retried

  interface PendingMessage {
    id: string;
    message: Message;
    timestamp: Date;
  }

  let pendingMessages = $state<PendingMessage[]>([]);

  // Function to retry sending pending messages
  async function retryPendingMessages() {
    if (pendingMessages.length === 0) return;

    console.log(`Attempting to retry ${pendingMessages.length} pending messages`);

    // Check if we're online and can reach the sync server
    if (!networkStatus.isOnline || !networkStatus.syncServerReachable) {
      console.log('Cannot retry messages - network or sync server unavailable');
      return;
    }

    // Make sure we have a channel to send to
    if (!g.channel) {
      console.log('No active channel to retry messages in');
      return;
    }

    // Try to send each pending message
    const messagesToRetry = [...pendingMessages];
    pendingMessages = [];

    for (const pendingMsg of messagesToRetry) {
      try {
        console.log('Retrying message:', pendingMsg.id);

        // Re-add the message to the channel timeline
        g.channel.timeline.push(pendingMsg.message);
        g.channel.commit();

        console.log('Successfully retried message:', pendingMsg.id);
        toast.success('Message sent', { position: 'bottom-end' });
      } catch (error) {
        console.error('Failed to retry message:', pendingMsg.id, error);
        // Add back to pending queue
        pendingMessages.push(pendingMsg);
      }
    }
  }

  // Set up an interval to retry pending messages
  let retryInterval: ReturnType<typeof setInterval> | undefined;
  onMount(() => {
    retryInterval = setInterval(() => {
      if (pendingMessages.length > 0) {
        retryPendingMessages();
      }
    }, 10000); // Try every 10 seconds
  });

  onDestroy(() => {
    if (retryInterval) clearInterval(retryInterval);
  });

  async function sendMessage() {
    console.log('Starting sendMessage function');
    if (!g.roomy || !g.space || !g.channel || !user.agent) {
      console.error('Missing required objects for sending message:', {
        roomy: !!g.roomy,
        space: !!g.space,
        channel: !!g.channel,
        agent: !!user.agent
      });
      return;
    }

    // Store the message input in case we need to retry
    const currentMessageInput = JSON.parse(JSON.stringify(messageInput));
    const currentReplyingTo = replyingTo;

    // Clear the input field immediately for better UX
    messageInput = {};
    replyingTo = undefined;

    try {
      console.log('Creating message...');
      const message = await g.roomy.create(Message);
      console.log('Message created:', message);

      try {
        // Try to set the author using the function approach
        if (typeof message.authors === "function") {
          console.log('Setting message author...');
          message.authors(
            (authors) => user.agent && authors.push(user.agent.assertDid),
          );
          console.log('Author set successfully');
        } else {
          // If authors is not a function, log a warning but continue
          console.warn("message.authors is not a function", message);
        }
      } catch (error) {
        console.error("Error setting message authors:", error);
      }

      console.log('Setting message body and date...');
      message.bodyJson = JSON.stringify(currentMessageInput);
      message.createdDate = new Date();

      console.log('Committing message...');
      message.commit();
      console.log('Message committed');

      if (currentReplyingTo) {
        console.log('Setting reply reference...');
        message.replyTo = currentReplyingTo;
      }

      // Check network status before trying to send
      if (!networkStatus.isOnline || !networkStatus.syncServerReachable) {
        console.log('Network or sync server unavailable, queuing message for later');
        pendingMessages.push({
          id: message.id,
          message: message,
          timestamp: new Date()
        });
        toast.success('Message queued for sending when connection is restored', { position: 'bottom-end' });
        return;
      }

      console.log('Adding message to channel timeline...');
      g.channel.timeline.push(message);

      console.log('Committing channel changes...');
      g.channel.commit();
      console.log('Channel committed');

      console.log('Message sent successfully');
    } catch (error) {
      console.error('Error sending message:', error);
      toast.error('Failed to send message. Will retry automatically.', { position: 'bottom-end' });

      // Try to reconnect if there was an error
      attemptReconnect();
    }
  }

  //
  // Settings Dialog
  //

  // All users can upload images now
  let showSettingsDialog = $state(false);
  let channelNameInput = $state("");
  let channelCategoryInput = $state(undefined) as undefined | string;
  $effect(() => {
    if (!g.space) return;

    untrack(() => {
      channelNameInput = g.channel?.name || "";
      channelCategoryInput = undefined;
      g.space?.sidebarItems.items().then((items) => {
        for (const item of items) {
          const category = item.tryCast(Category);
          if (
            category &&
            g.channel &&
            category.channels.ids().includes(g.channel.id)
          ) {
            channelCategoryInput = category.id;
            return;
          }
        }
      });
    });
  });

  async function saveSettings() {
    if (!g.space || !g.channel) return;
    if (channelNameInput) {
      g.channel.name = channelNameInput;
      g.channel.commit();
    }

    if (g.channel instanceof Channel) {
      let foundChannelInSidebar = false;
      for (const [
        cursor,
        unknownItem,
      ] of await g.space.sidebarItems.itemCursors()) {
        const item =
          unknownItem.tryCast(Category) || unknownItem.tryCast(Channel);

        if (item instanceof Channel && item.id === g.channel.id) {
          foundChannelInSidebar = true;
        }

        if (item instanceof Category) {
          const categoryItems = item.channels.ids();
          if (item.id !== channelCategoryInput) {
            const thisChannelIdx = categoryItems.indexOf(g.channel.id);
            if (thisChannelIdx !== -1) {
              item.channels.remove(thisChannelIdx);
              item.commit();
            }
          } else if (
            item.id === channelCategoryInput &&
            !categoryItems.includes(g.channel.id)
          ) {
            item.channels.push(g.channel);
            item.commit();
          }
        } else if (
          item instanceof Channel &&
          channelCategoryInput &&
          item.id === g.channel.id
        ) {
          const { offset } = g.space.entity.doc.getCursorPos(cursor);
          g.space.sidebarItems.remove(offset);
        }
      }

      if (!channelCategoryInput && !foundChannelInSidebar) {
        g.space.sidebarItems.push(g.channel);
      }
      g.space.commit();
    }

    showSettingsDialog = false;
  }

  // Image upload is now handled in ChatInput.svelte
</script>

<header class="navbar">
  <div class="navbar-start flex gap-4">
    {#if g.channel}
      {#if isMobile}
        <Button.Root
          onclick={() =>
            navigate(page.params.space ? { space: page.params.space } : "home")}
        >
          <Icon icon="uil:left" />
        </Button.Root>
      {/if}

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
        <Tabs.Trigger value="chat" class="tab flex gap-2">
          <Icon icon="tabler:message" class="text-2xl" />
          {#if !isMobile}
            <p>Chat</p>
          {/if}
        </Tabs.Trigger>
        <Tabs.Trigger value="threads" class="tab flex gap-2">
          <Icon
            icon="material-symbols:thread-unread-rounded"
            class="text-2xl"
          />
          {#if !isMobile}
            <p>Threads</p>
          {/if}
        </Tabs.Trigger>
        <Tabs.Trigger value="wiki" class="tab flex gap-2">
          <Icon icon="tabler:notebook" class="text-2xl" />
          {#if !isMobile}
            <p>Wiki</p>
          {/if}
        </Tabs.Trigger>
      </Tabs.List>
    </Tabs.Root>
  {/if}

  {#if !isMobile}
    <div class="navbar-end">
      {@render toolbar()}
    </div>
  {/if}
</header>
<div class="divider my-0"></div>

{#if tab === "chat" || g.channel instanceof Thread}
  {@render chatTab()}
{:else if tab === "threads"}
  {@render threadsTab()}
{:else if tab === "wiki"}
  {@render wikiTab()}
{/if}

{#snippet threadsTab()}
  <ul class="list w-full join join-vertical">
    {#if relatedThreads.value.length > 0}
      {#each relatedThreads.value as thread}
        <a href={`/${page.params.space}/thread/${thread.id}`}>
          <li class="list-row join-item flex items-center w-full bg-base-200">
            <h3 class="card-title text-xl font-medium text-primary">
              {thread.name}
            </h3>
            {#if thread.createdDate}
              {@render timestamp(thread.createdDate)}
            {/if}
          </li>
        </a>
      {/each}
    {:else}
      No threads for this channel.
    {/if}
  </ul>
{/snippet}

{#snippet timestamp(date: Date)}
  {@const formattedDate = isToday(date) ? "Today" : format(date, "P")}
  <time class="text-xs">
    {formattedDate}, {format(date, "pp")}
  </time>
{/snippet}

{#snippet chatTab()}
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
                  {#await getReplyingToProfile() then profile}
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

            <!-- Image upload button is now in ChatInput.svelte -->
          </div>
        </section>
      {/if}

      {#if isMobile}
        {@render toolbar()}
      {/if}
    </div>
  {/if}
{/snippet}

{#snippet toolbar()}
  <menu class="relative flex items-center gap-3 px-2 w-fit justify-end">
    <Popover.Root bind:open={isThreading.value}>
      <Popover.Trigger>
        <Icon icon="tabler:needle-thread" class="text-2xl" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="left"
          sideOffset={8}
          interactOutsideBehavior="ignore"
          class="my-4 bg-base-300 rounded py-4 px-5"
        >
          <form onsubmit={createThread} class="flex flex-col gap-4">
            <input
              type="text"
              bind:value={threadTitleInput}
              class="input"
              placeholder="Thread Title"
            />
            <button type="submit" class="btn btn-primary">
              Create Thread
            </button>
          </form>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
    <Button.Root
      title="Copy invite link"
      class="cursor-pointer hover:scale-105 active:scale-95 transition-all duration-150"
      onclick={() => {
        navigator.clipboard.writeText(`${page.url.href}`);
      }}
    >
      <Icon icon="icon-park-outline:copy-link" class="text-2xl" />
    </Button.Root>

    {#if g.isAdmin}
      <Dialog
        title={g.channel instanceof Channel
          ? "Channel Settings"
          : "Thread Settings"}
        bind:isDialogOpen={showSettingsDialog}
      >
        {#snippet dialogTrigger()}
          <Button.Root
            title={g.channel instanceof Channel
              ? "Channel Settings"
              : "Thread Settings"}
            class="cursor-pointer hover:scale-105 active:scale-95 transition-all duration-150 m-auto flex"
          >
            <Icon icon="lucide:settings" class="text-2xl" />
          </Button.Root>
        {/snippet}

        <form class="flex flex-col gap-4 w-full" onsubmit={saveSettings}>
          <label>
            Name
            <input
              bind:value={channelNameInput}
              placeholder="name"
              class="input"
            />
          </label>
          {#if g.space && g.channel instanceof Channel}
            <select bind:value={channelCategoryInput} class="select">
              <option value={undefined}>None</option>
              {#await g.space.sidebarItems.items() then sidebarItems}
                {@const categories = sidebarItems
                  .map((x) => x.tryCast(Category))
                  .filter((x) => !!x)}

                {#each categories as category}
                  <option value={category.id}>{category.name}</option>
                {/each}
              {/await}
            </select>
          {/if}
          <Button.Root class="btn btn-primary">Save Settings</Button.Root>
        </form>

        <form
          onsubmit={(e) => {
            e.preventDefault();
            if (!g.channel) return;
            g.channel.softDeleted = true;
            g.channel.commit();
            showSettingsDialog = false;
            navigate({ space: page.params.space! });
          }}
          class="flex flex-col gap-3 mt-3"
        >
          <h2 class="text-xl font-bold">Danger Zone</h2>
          <p>
            Deleting a {g.channel instanceof Channel ? "channel" : "thread"} doesn't
            delete the data permanently, it just hides the thread from the UI.
          </p>
          <Button.Root class="btn btn-error"
            >Delete {g.channel instanceof Channel
              ? "Channel"
              : "Thread"}</Button.Root
          >
        </form>
      </Dialog>
    {/if}
  </menu>
{/snippet}

{#snippet wikiTab()}
  <WikiEditor />
{/snippet}
