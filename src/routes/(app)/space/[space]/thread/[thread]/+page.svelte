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
  import ChatArea from "$lib/components/ChatArea.svelte";
  import ChatInput from "$lib/components/ChatInput.svelte";
  import AvatarImage from "$lib/components/AvatarImage.svelte";
  import { Button, Popover } from "bits-ui";

  import type {
  Announcement,
    Did,
    Space,
    Ulid,
  } from "$lib/schemas/types";
  import type { Autodoc } from "$lib/autodoc/peer";
  import Dialog from "$lib/components/Dialog.svelte";
  import { isAnnouncement } from "$lib/utils";

  let isMobile = $derived((outerWidth.current ?? 0) < 640);

  let spaceContext = getContext("space") as { get value(): Autodoc<Space> | undefined };
  let space = $derived(spaceContext.value);
  let thread = $derived(space?.view.threads[page.params.thread]);
  let users: { value: Item[] } = getContext("users");
  let contextItems: { value: Item[] } = getContext("contextItems");
  let isAdmin: { value: boolean } = getContext("isAdmin");

  let messageInput = $state({});
  let imageFiles: FileList | null = $state(null);

  // thread maker
  let isThreading = $state({ value: false });
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
    if (!space || !thread) return;

    space.change((doc) => {
      const threadId = ulid();
      const threadTimeline: string[] = [];

      // messages can be selected in any order
      // sort them on create based on their position from the thread
      selectedMessages.sort((a,b) => {
        return thread.timeline.indexOf(a) - thread.timeline.indexOf(b)
      });

      for (const id of selectedMessages) {
        // move selected message ID from old thread to new thread timeline
        threadTimeline.push(id);
        const index = thread?.timeline.indexOf(id);
        doc.threads[page.params.thread].timeline.splice(index, 1);

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
        doc.threads[page.params.thread].timeline.splice(index, 0, announcementId);
      }

      // create thread
      doc.threads[threadId] = {
        title: threadTitleInput,
        timeline: threadTimeline,
        relatedChannel: thread.relatedChannel
      };
      
      // create an Announcement about the new Thread in current channel
      const announcementId = ulid();
      const announcement: Announcement = {
        kind: "threadCreated",
        relatedThreads: [threadId],
        reactions: {}
      };

      doc.messages[announcementId] = announcement; 
      doc.threads[page.params.thread].timeline.push(announcementId);
    });

    threadTitleInput = "";
    isThreading.value = false;
    toast.success("Thread created", { position: "bottom-end" });
  }

  async function sendMessage() {
    if (!space) return;

    /* TODO: rework with tiptap?
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
      };
      doc.threads[page.params.thread].timeline.push(id);
    });

    messageInput = {};
    replyingTo = null;
    imageFiles = null;
  }

  let isDeleteThreadDialogOpen = $state(false);
  function softDeleteThread() {
    if (!space || !thread) { return }
    isDeleteThreadDialogOpen = false;

    space.change((doc) => {
      // soft delete messages and announcements related to thread
      for (const ulid of Object.keys(doc.messages)) {
        if (
          isAnnouncement(doc.messages[ulid])
        ) {
          const announcement = doc.messages[ulid];
          if ((
              announcement.kind === "threadCreated" 
              && announcement.relatedThreads?.includes(page.params.thread)
            ) || (
              announcement.kind === "messageMoved" 
              && new Set(announcement.relatedMessages).union(new Set(thread.timeline)).size > 0
            )
          ) {
            doc.messages[ulid].softDeleted = true;
          }
        }
      }

      for (const ulid of thread.timeline) {
        doc.messages[ulid].softDeleted = true;
      }

      // soft delete thread
      doc.threads[page.params.thread].softDeleted = true;
    });

    toast.success("Thread deleted", { position: "bottom-end" });
    goto(`/space/${page.params.space}`);
  }
</script>

<header class="flex flex-none items-center justify-between border-b-1 pb-4">
  <div class="flex gap-4 items-center">
    {#if isMobile}
      <Button.Root onclick={() => goto(`/space/${page.params.space}`)}>
        <Icon icon="uil:left" color="white" />
      </Button.Root>
    {:else}
      <AvatarImage handle={thread?.title ?? ""} />
    {/if}

    {#if space && thread}
      <h4 class={`${isMobile && "line-clamp-1 overflow-hidden text-ellipsis"} text-white text-lg font-bold`}>
        {thread.title}
      </h4>
      <p class="text-gray-400 text-xs">{">"}</p>
      <a href={`/space/${page.params.space}/${thread.relatedChannel}`} class="text-xs mention channel-mention">
        {space.view.channels[thread.relatedChannel].name}
      </a>
    {/if}
  </div>


  {#if !isMobile}
    <div class="flex">
      {@render toolbar()}
    </div>
  {/if}
</header>

{#if space}
  <ChatArea
    source={{ type: "space", space: space }}
    timeline={thread?.timeline ?? []}
  />
  <div class="flex float-end">
    {#if !isMobile || !isThreading.value}
      <section class="grow flex flex-col">
        {#if replyingTo}
          <div
            class="flex justify-between bg-violet-800 text-white rounded-t-lg px-4 py-2"
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
              class="cursor-pointer hover:scale-105 active:scale-95 transition-all duration-150"
            >
              <Icon icon="zondicons:close-solid" />
            </Button.Root>
          </div>
        {/if}
        <div class="relative">
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

{#snippet toolbar()}
  <menu class="relative flex items-center gap-3 px-2 w-fit self-end">
    <Popover.Root bind:open={isThreading.value}> 
      <Popover.Trigger>
        <Icon
          icon="tabler:needle-thread"
          color="white"
          class="text-2xl"
        />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content 
          side="left" 
          sideOffset={8} 
          interactOutsideBehavior="ignore" 
          class="my-4 text-white bg-violet-900 rounded py-4 px-5"
        >
          <form onsubmit={createThread} class="flex flex-col gap-4">
            <input type="text" bind:value={threadTitleInput} class="bg-violet-800 px-2 py-1" placeholder="Thread Title" />
            <button 
              type="submit" 
              class="btn text-violet-900 bg-white"
            >
              Create Thread
            </button>
          </form>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>

    <Button.Root
      title="Copy invite link"
      class="btn"
      onclick={() => {
        navigator.clipboard.writeText(`${page.url.href}`);
      }}
    >
      <Icon icon="icon-park-outline:copy-link" color="white" class="text-2xl" />
    </Button.Root>

    {#if isAdmin.value}
      <Dialog 
        title="Delete thread?" 
        description={`You are deleting ${thread?.title}. This is only reversible by the Space's admins.`}
        bind:isDialogOpen={isDeleteThreadDialogOpen}
      >
        {#snippet dialogTrigger()}
          <Icon icon="tabler:trash" color="red" class="text-2xl" />
        {/snippet}

        <Button.Root onclick={softDeleteThread} class="btn bg-red-500 text-white">
          Delete
        </Button.Root>
      </Dialog>
    {/if}
  </menu>
{/snippet}