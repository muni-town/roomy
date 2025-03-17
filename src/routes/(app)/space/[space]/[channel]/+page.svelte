<script lang="ts">
  import _ from "underscore";
  import { decodeTime, ulid } from "ulidx";
  import { page } from "$app/state";
  import { getContext, setContext } from "svelte";
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

  import type {
    Did,
    Space,
    Channel,
    Ulid,
    Announcement,
    Thread,
  } from "$lib/schemas/types";
  import type { Autodoc } from "$lib/autodoc/peer";
  import { format, isToday } from "date-fns";

  import { onMount, onDestroy } from "svelte";
  import WikiEditor from "$lib/components/WikiEditor.svelte";

  let isMobile = $derived((outerWidth.current ?? 0) < 640);

  let spaceContext = getContext("space") as { get value(): Autodoc<Space> | undefined };
  let space = $derived(spaceContext.value);
  let channel = $derived(space?.view.channels[page.params.channel]) as
    | Channel
    | undefined;

  let users: { value: Item[] } = getContext("users");
  let contextItems: { value: Item[] } = getContext("contextItems");
  let relatedThreads = $derived.by(() => {
    let related: { [ulid: string]: Thread } = {};
    if (space && channel) {
      Object.entries(space.view.threads).map(([ulid, thread]) => {
        if (!thread.softDeleted && thread.relatedChannel === page.params.channel) {
          related[ulid] = thread;
        }
      });
    }
    return related;
  });

  let tab = $state<"chat" | "threads">("chat");

  let messageInput = $state({});
  let imageFiles: FileList | null = $state(null);

  // thread maker
  let isThreading = $state({ value: false });
  $inspect({ isThreading })
  let threadTitleInput = $state("");
  let selectedMessages: Ulid[] = $state([]);
  setContext("isThreading", isThreading);
  setContext("selectMessage", (message: Ulid) => {
    selectedMessages.push(message);
  });
  setContext("removeSelectedMessage", (message: Ulid) => {
    selectedMessages = selectedMessages.filter((m) => m != message);
  });
  setContext("deleteMessage", (message: Ulid) => {
    if (!space) { return; }
    space.change((doc) => {
      // TODO: don't remove from timeline, just delete ID? We need to eventually add a marker
      // showing the messages is deleted in the timeline.
      Object.values(doc.channels).forEach((x) => {
        const idx = x.timeline.indexOf(message);
        if (idx !== -1) x.timeline.splice(idx, 1);
      });
      Object.values(doc.threads).forEach((x) => {
        const idx = x.timeline.indexOf(message);
        if (idx !== -1) x.timeline.splice(idx, 1);
      });
      delete doc.messages[message];
    });
  });

  $effect(() => {
    if (!isThreading.value && selectedMessages.length > 0) {
      selectedMessages = [];
    }
  });

  // Reply Utils
  let replyingTo = $state<{
    id: Ulid;
    authorProfile: { handle: string; avatarUrl: string };
    content: string;
  } | null>();

  setContext(
    "setReplyTo",
    (value: {
      id: Ulid;
      authorProfile: { handle: string; avatarUrl: string };
      content: string;
    }) => {
      replyingTo = value;
    },
  );

  setContext("toggleReaction", (id: Ulid, reaction: string) => {
    if (!space) return;

    space.change((doc) => {
      const did = user.profile.data?.did;
      if (!did) return;

      let reactions = doc.messages[id].reactions[reaction] ?? [];

      if (reactions.includes(did)) {
        if (doc.messages[id].reactions[reaction].length - 1 === 0) {
          delete doc.messages[id].reactions[reaction];
        } else {
          doc.messages[id].reactions[reaction] = reactions.filter(
            (actor: Did) => actor !== did,
          );
        }
      } else {
        if (!doc.messages[id].reactions) {
          // init reactions object
          doc.messages[id].reactions = {};
        }
        doc.messages[id].reactions[reaction] = [...reactions, did];
      }
    });
  });

  function createThread(e: SubmitEvent) {
    e.preventDefault();
    if (!space || !channel) return;

    space.change((doc) => {
      const threadId = ulid();
      const threadTimeline: string[] = [];

      // messages can be selected in any order
      // sort them on create based on their position from the channel
      selectedMessages.sort((a,b) => {
        return channel.timeline.indexOf(a) - channel.timeline.indexOf(b)
      });

      for (const id of selectedMessages) {
        // move selected message ID from channel to thread timeline
        threadTimeline.push(id);
        const index = channel?.timeline.indexOf(id);
        doc.channels[page.params.channel].timeline.splice(index, 1);

        // create an Announcement about the move for each message
        const announcementId = ulid();
        const announcement: Announcement = {
          kind: "messageMoved",
          relatedMessages: [id],
          relatedThreads: [threadId],
          reactions: {}
        };

        doc.messages[announcementId] = announcement; 

        // push announcement at moved message's index
        doc.channels[page.params.channel].timeline.splice(index, 0, announcementId);
      }

      // create thread
      doc.threads[threadId] = {
        title: threadTitleInput,
        timeline: threadTimeline,
        relatedChannel: page.params.channel
      };
      
      // create an Announcement about the new Thread in current channel
      const announcementId = ulid();
      const announcement: Announcement = {
        kind: "threadCreated",
        relatedThreads: [threadId],
        reactions: {}
      };

      doc.messages[announcementId] = announcement; 
      doc.channels[page.params.channel].timeline.push(announcementId);
    });

    threadTitleInput = "";
    isThreading.value = false;
    toast.success("Thread created", { position: "bottom-end" });
  }

  async function sendMessage() {
    if (!space) return;

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
    space.change((doc) => {
      if (!user.agent) return;

      const id = ulid();
      doc.messages[id] = {
        author: user.agent.assertDid,
        reactions: {},
        content: JSON.stringify(messageInput),
        ...(replyingTo && { replyTo: replyingTo.id }),
        // TODO: image upload refactor with tiptap
        // ...(images && { images }),
      };
      doc.channels[page.params.channel].timeline.push(id);
    });

    messageInput = {};
    replyingTo = null;
    imageFiles = null;
  }

  //
  // Settings Dialog
  //

  let { value: isAdmin }: { value: boolean } = getContext("isAdmin");

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
    if (!space) { return }
    channelNameInput = channel?.name || "";
    channelCategoryInput = Object.entries(space.view.categories).find(
      ([_id, category]) => category.channels.includes(page.params.channel),
    )?.[0];
  });

  function saveSettings() {
    space?.change((space) => {
      if (channelNameInput) {
        space.channels[page.params.channel].name = channelNameInput;
      }
      Object.entries(space.categories).forEach(([catId, category]) => {
        if (channelCategoryInput !== catId) {
          const idx = category.channels.indexOf(page.params.channel);
          if (idx !== -1) {
            category.channels.splice(idx, 1);
          }
        }
        if (channelCategoryInput) {
          const category = space.categories[channelCategoryInput];
          if (!category.channels.includes(page.params.channel)) {
            category.channels.push(page.params.channel);
          }
          const idx = space.sidebarItems.findIndex(
            (x) => x.type == "channel" && x.id == page.params.channel,
          );
          if (idx !== -1) {
            space.sidebarItems.splice(idx, 1);
          }
        } else if (
          !space.sidebarItems.find(
            (x) => x.type == "channel" && x.id == page.params.channel,
          )
        ) {
          space.sidebarItems.push({ type: "channel", id: page.params.channel });
        }
      });
    });
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
    {#if isMobile}
      <Button.Root onclick={() => goto(`/space/${page.params.space}`)}>
        <Icon icon="uil:left" />
      </Button.Root>
    {:else}
      <AvatarImage avatarUrl={channel?.avatar} handle={channel?.name ?? ""} />
    {/if}

    <h4 class={`${isMobile && "line-clamp-1 overflow-hidden text-ellipsis"} text-base-content text-lg font-bold`}>
      {channel?.name}
    </h4>
  </div>

  <Tabs.Root bind:value={tab} class={isMobile ? "navbar-end" : "navbar-center"}>
    <Tabs.List class="tabs tabs-box">
      <Tabs.Trigger
        value="chat"
        onclick={() => goto(page.url.pathname)}
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
        <Icon icon="material-symbols:thread-unread-rounded" class="text-2xl" />
        {#if !isMobile}
          <p>Threads</p>
        {/if}
      </Tabs.Trigger>
      <Tabs.Trigger
        value="wiki"
        class="flex gap-2 w-full justify-center transition-all duration-150 items-center px-4 py-1 data-[state=active]:bg-violet-800 rounded"
      >
        <Icon icon="tabler:notebook" color="white" class="text-2xl" />
        {#if !isMobile}
          <p>Wiki</p>
        {/if}
      </Tabs.Trigger>
    </Tabs.List>
  </Tabs.Root>

  {#if !isMobile}
    <div class="navbar-end">
      {@render toolbar()}
    </div>
  {/if}
</header>
<div class="divider my-0"></div>


{#if tab === "chat"}
  {@render chatTab()}
{:else if tab === "threads"}
  {@render threadsTab()}
{:else if tab === "wiki"}
  {@render wikiTab()}
{/if}

{#snippet threadsTab()}
  <ul class="list w-full join join-vertical">
    {#each Object.entries(relatedThreads) as [ulid, thread]}
      <a href={`/space/${page.params.space}/thread/${ulid}`}>
        <li class="list-row join-item flex items-center w-full bg-base-200">
          <h3 class="card-title text-xl font-medium text-primary">{thread.title}</h3>
          {@render timestamp(ulid)}
        </li>
      </a>
    {/each}
  </ul>
{/snippet}

{#snippet timestamp(ulid: Ulid)}
  {@const decodedTime = decodeTime(ulid)}
  {@const formattedDate = isToday(decodedTime)
    ? "Today"
    : format(decodedTime, "P")}
  <time class="text-xs">
    {formattedDate}, {format(decodedTime, "pp")}
  </time>
{/snippet}

{#snippet chatTab()}
  {#if space}
    <ChatArea
      source={{ type: "space", space: space }}
      timeline={channel?.timeline ?? []}
    />
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
                  <AvatarImage
                    handle={replyingTo.authorProfile.handle}
                    avatarUrl={replyingTo.authorProfile.avatarUrl}
                    className="!w-4"
                  />
                  <strong>{replyingTo.authorProfile.handle}</strong>
                </h5>
                <p class="text-gray-300 text-ellipsis italic">
                  {@html getContentHtml(replyingTo.content)}
                </p>
              </div>
              <Button.Root
                type="button"
                onclick={() => (replyingTo = null)}
                class="btn btn-circle btn-ghost"
              >
                <Icon icon="zondicons:close-solid" />
              </Button.Root>
            </div>
          {/if}
          <div class="relative">
            <!-- TODO: get all users that has joined the server -->
            <ChatInput 
              bind:content={messageInput} 
              users={users.value}
              context={contextItems.value}
              onEnter={sendMessage}
            />
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
        <Icon
          icon="tabler:needle-thread"
          class="text-2xl"
        />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content 
          side="left" 
          sideOffset={8} 
          interactOutsideBehavior="ignore" 
          class="my-4 bg-base-300 rounded py-4 px-5"
        >
          <form onsubmit={createThread} class="flex flex-col gap-4">
            <input type="text" bind:value={threadTitleInput} class="input" placeholder="Thread Title" />
            <button 
              type="submit" 
              class="btn btn-primary"
            >
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

    {#if isAdmin}
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
          {#if space}
            <select bind:value={channelCategoryInput} class="select">
              <option value={undefined}>None</option>
              {#each Object.keys(space.view.categories) as categoryId}
                {@const category = space.view.categories[categoryId]}
                <option value={categoryId}>{category.name}</option>
              {/each}
            </select>
          {/if}
          <Button.Root class="btn btn-primary">
            Save Settings
          </Button.Root>
        </form>
      </Dialog>
    {/if}
  </menu>
{/snippet}

{#snippet wikiTab()}
  {#if space}
    {#if channel !== undefined && isAdmin !== undefined}
      <WikiEditor
        {space}
        {channel}
        {isAdmin}
      />
    {/if}
  {/if}
{/snippet}
