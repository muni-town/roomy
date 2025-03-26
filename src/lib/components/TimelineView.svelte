<script lang="ts">
  import _ from "underscore";
  import { page } from "$app/state";
  import { getContext, setContext, untrack } from "svelte";
  import { goto } from "$app/navigation";
  import toast from "svelte-french-toast";
  import { user } from "$lib/user.svelte";
  import { getContentHtml, type Item } from "$lib/tiptap/editor";
  import { outerWidth } from "svelte/reactivity/window";

  import Icon from "@iconify/svelte";
  import Dialog from "$lib/components/Dialog.svelte";
  import ChatArea from "$lib/components/ChatArea.svelte";
  import ChatInput from "$lib/components/ChatInput.svelte";
  import AvatarImage from "$lib/components/AvatarImage.svelte";
  import { Button, Popover, Tabs } from "bits-ui";

  import { format, isToday } from "date-fns";
  import { derivePromise } from "$lib/utils.svelte";
  import { g } from "$lib/global.svelte";
  import {
    Announcement,
    Category,
    Channel,
    Message,
    Image,
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
    const hash = window.location.hash.replace('#', '');
    if (hash === 'chat' || hash === 'threads' || hash === 'wiki') {
      tab = hash as "chat" | "threads" | "wiki";
    }
  }

  $effect(() => {
    updateTabFromHash();
    
    // Add listener for hash changes
    window.addEventListener('hashchange', updateTabFromHash);
    
    // Cleanup when component is destroyed
    return () => {
      window.removeEventListener('hashchange', updateTabFromHash);
    };
  });

  // Update the hash when tab changes
  $effect(() => {
    if (tab) {
      window.location.hash = tab;
    }
  });

  let messageInput: JSONContent = $state({});
  let imageFiles: FileList | null = $state(null);

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
    if (!g.space || !g.channel) return;

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
    if (!g.space || !g.channel || !user.agent) return;

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
    message.authors.push(user.agent.assertDid);
    message.bodyJson = JSON.stringify(messageInput);
    message.createdDate = new Date();
    message.commit();
    if (replyingTo) message.replyTo = replyingTo;

    // TODO: image upload refactor with tiptap

    g.channel.timeline.push(message);
    g.channel.commit();

    messageInput = {};
    replyingTo = undefined;
    imageFiles = null;
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
  let showSettingsDialog = $state(false);
  let channelNameInput = $state("");
  let channelCategoryInput = $state(undefined) as undefined | string;
  $effect(() => {
    if (!g.space) return;

    untrack(() => {
      channelNameInput = g.channel?.name || "";
      channelCategoryInput = undefined;
      g.space &&
        g.space.sidebarItems.items().then((items) => {
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

        if (item instanceof Channel && item.id == g.channel.id) {
          foundChannelInSidebar = true;
        }

        if (item instanceof Category) {
          const categoryItems = item.channels.ids();
          if (item.id !== channelCategoryInput) {
            const thisChannelIdx = categoryItems.indexOf(g.channel.id);
            if (thisChannelIdx != -1) {
              item.channels.remove(thisChannelIdx);
              item.commit();
            }
          } else if (
            item.id == channelCategoryInput &&
            !categoryItems.includes(g.channel.id)
          ) {
            item.channels.push(g.channel);
            item.commit();
          }
        } else if (
          item instanceof Channel &&
          channelCategoryInput &&
          item.id == g.channel.id
        ) {
          const { offset } = g.space.entity.doc.getCursorPos(cursor);
          g.space.sidebarItems.remove(offset);
        }
      }

      console.log("category input", channelCategoryInput);
      if (!channelCategoryInput && !foundChannelInSidebar) {
        g.space.sidebarItems.push(g.channel);
      }
      g.space.commit();
    }

    showSettingsDialog = false;
  }

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
      {#if isMobile}
        <Button.Root onclick={() => goto(`/${page.params.space}`)}>
          <Icon icon="uil:left" />
        </Button.Root>
      {:else}
        {#await g.channel.image && g.roomy.open(Image, g.channel.image) then image}
          <!-- TODO: We're using #key to recreate avatar image when channel changes since for some reason the
          avatarimage component doesn't re-render properly by itself.  -->
          {#key g.channel.id}
            <AvatarImage avatarUrl={image?.uri} handle={g.channel.id} />
          {/key}
        {/await}
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
        <Tabs.Trigger
          value="chat"
          class="tab flex gap-2"
        >
          <Icon icon="tabler:message" class="text-2xl" />
          {#if !isMobile}
            <p>Chat</p>
          {/if}
        </Tabs.Trigger>
        <Tabs.Trigger 
          value="threads" 
          class="tab flex gap-2"
        >
          <Icon
            icon="material-symbols:thread-unread-rounded"
            class="text-2xl"
          />
          {#if !isMobile}
            <p>Threads</p>
          {/if}
        </Tabs.Trigger>
        <Tabs.Trigger 
          value="wiki" 
          class="tab flex gap-2"
        >
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
                  {#await getProfile(replyingTo.authors.get(0)) then profile}
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
            {#if g.roomy.spaces.ids().includes(g.space.id)}
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
                  if (g.space) {
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
      <Dialog title="Channel Settings" bind:isDialogOpen={showSettingsDialog}>
        {#snippet dialogTrigger()}
          <Button.Root
            title="Channel Settings"
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
              placeholder="channel-name"
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
      </Dialog>
    {/if}
  </menu>
{/snippet}

{#snippet wikiTab()}
  <WikiEditor />
{/snippet}
