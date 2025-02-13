<script lang="ts">
  import type { Autodoc } from "$lib/autodoc/peer";
  import ChatArea from "$lib/components/ChatArea.svelte";
  import { g } from "$lib/global.svelte";
  import type {
    Did,
    Space,
    SpaceChannel,
    Thread,
    Ulid,
  } from "$lib/schemas/types";
  import { page } from "$app/state";
  import { user } from "$lib/user.svelte";
  import { setContext, untrack } from "svelte";
  import {
    Avatar,
    Button,
    Dialog,
    Popover,
    Separator,
    Tabs,
    Toggle,
  } from "bits-ui";
  import { AvatarBeam } from "svelte-boring-avatars";
  import Icon from "@iconify/svelte";
  import { fade, fly } from "svelte/transition";
  import { ulid } from "ulidx";
  import ThreadRow from "$lib/components/ThreadRow.svelte";
  import { goto } from "$app/navigation";
  import ChatMessage from "$lib/components/ChatMessage.svelte";
  import toast from "svelte-french-toast";
  import _ from "underscore";
  import { renderMarkdownSanitized } from "$lib/markdown";
  import { outerWidth } from "svelte/reactivity/window";
  import AvatarImage from "$lib/components/AvatarImage.svelte";

  let isMobile = $derived((outerWidth.current ?? 0) < 640);

  let tab = $state("chat");
  let space: Autodoc<Space> | undefined = $derived(g.spaces[page.params.space]);
  let channel = $derived(space.view.channels[page.params.channel]) as
    | SpaceChannel
    | undefined;
  let messageInput = $state("");
  let currentThread = $derived.by(() => {
    if (page.url.searchParams.has("thread")) {
      return space.view.threads[page.url.searchParams.get("thread")!] as Thread;
    } else {
      return null;
    }
  });

  // // Load bluesky profile
  // let profile = $state(undefined) as ProfileViewDetailed | undefined;
  // $effect(() => {
  //   if (user.agent && !profile) {
  //     user.agent.getProfile({ actor: page.params.did }).then((resp) => {
  //       if (resp.success) {
  //         profile = resp.data;
  //       }
  //     });
  //   }
  // });

  $effect(() => {
    if (currentThread) {
      tab = "threads";
    }
  });

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

  $effect(() => {
    if (!isThreading.value && selectedMessages.length > 0) {
      selectedMessages = [];
    }
  });

  // Reply Utils
  let replyingTo = $state<{
    id: Ulid;
    profile: { handle: string; avatarUrl: string };
    content: string;
  } | null>();

  setContext(
    "setReplyTo",
    (value: {
      id: Ulid;
      profile: { handle: string; avatarUrl: string };
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

  // // Mark the current DM as read.
  // $effect(() => {
  //   const did = page.params.did!;
  //   const doc = space?.view;
  //   untrack(() => {
  //     const unread = unreadCount(
  //       doc,
  //       g.catalog?.view.dms[did]?.viewedHeads || [],
  //     );
  //     if (g.catalog?.view.dms[did]?.viewedHeads && doc && unread > 0) {
  //       // TODO: Find ways to reduce how frequently we write to this, because the size of the
  //       // catalog grows every time we send / receive a message and update the latest heads.
  //       g.catalog?.change((doc) => {
  //         doc.dms[did].viewedHeads = channel.heads();
  //       });
  //     }
  //   });
  // });

  // function openDirectMessage() {
  //   if (g.catalog && profile) {
  //     g.catalog.change((doc) => {
  //       doc.dms[page.params.did] = {
  //         name: profile!.handle,
  //         avatar: profile!.avatar,
  //       };
  //     });
  //   }
  // }

  function createThread(e: SubmitEvent) {
    e.preventDefault();
    if (!space) return;

    space.change((doc) => {
      const id = ulid();
      const timeline = [];
      for (const id of selectedMessages) {
        timeline.push(`${id}`);
      }
      doc.threads[id] = {
        title: threadTitleInput,
        timeline,
      };
    });

    threadTitleInput = "";
    isThreading.value = false;
    toast.success("Thread created", { position: "bottom-end" });
  }

  function sendMessage(e: SubmitEvent) {
    e.preventDefault();
    if (!space) return;

    space.change((doc) => {
      if (!user.agent) return;

      const id = ulid();
      doc.messages[id] = {
        author: user.agent.assertDid,
        reactions: {},
        content: messageInput,
        ...(replyingTo && { replyTo: replyingTo.id }),
      };
      doc.channels[page.params.channel].timeline.push(id);
    });

    messageInput = "";
    replyingTo = null;
  }

  function deleteThread(id: Ulid) {
    if (!space) return;

    space.change((doc) => {
      delete doc.threads[id];
    });

    toast.success("Thread deleted", { position: "bottom-end" });
    goto(page.url.pathname);
  }
</script>

<header class="flex flex-none items-center justify-between border-b-1 pb-4">
  <div class="flex gap-4 items-center">
    {#if isMobile}
      <Button.Root onclick={() => goto(`/space/${page.params.space}`)}>
        <Icon icon="uil:left" color="white" />
      </Button.Root>
    {:else}
      <AvatarImage avatarUrl={channel?.avatar} handle={channel?.name ?? ""} />
    {/if}

    <span class="flex gap-2 items-center">
      {#if !isMobile || (isMobile && !currentThread)}
        <h4 class={`${isMobile && "line-clamp-1 overflow-hidden text-ellipsis"} text-white text-lg font-bold`}>
          {channel?.name}
        </h4>
      {/if}

      {#if currentThread}
        {#if !isMobile}
          <Icon icon="mingcute:right-line" color="white" />
        {/if}
        <Icon icon="lucide-lab:reel-thread" color="white" />
        <h5 class="text-white text-lg font-bold overflow-ellipsis">
          {currentThread.title}
        </h5>
      {/if}
    </span>
  </div>

    <Tabs.Root bind:value={tab}>
      <Tabs.List class="grid grid-cols-2 gap-4 border text-white p-1 rounded">
        <Tabs.Trigger
          value="chat"
          onclick={() => goto(page.url.pathname)}
          class="flex gap-2 w-full justify-center transition-all duration-150 items-center px-4 py-1 data-[state=active]:bg-violet-800 rounded"
        >
          <Icon icon="tabler:message" color="white" class="text-2xl" />
          {#if !isMobile}
            <p>Chat</p>
          {/if}
        </Tabs.Trigger>
        <Tabs.Trigger
          value="threads"
          class="flex gap-2 w-full justify-center transition-all duration-150 items-center px-4 py-1 data-[state=active]:bg-violet-800 rounded"
        >
          <Icon
            icon="material-symbols:thread-unread-rounded"
            color="white"
            class="text-2xl"
          />
          {#if !isMobile}
            <p>Threads</p>
          {/if}
        </Tabs.Trigger>
      </Tabs.List>
    </Tabs.Root>

  {#if !isMobile}
    <div class="flex">
      {@render toolbar({ growButton: false })}
    </div>
  {/if}
</header>

{#if tab === "chat"}
  {@render chatTab()}
{:else if tab === "threads"}
  {@render threadsTab()}
{/if}

{#snippet chatTab()}
  {#if space} 
    <ChatArea
      source={{ type: "space", space, channelId: page.params.channel }}
    />
    <div class="flex">
      {#if !isMobile || !isThreading.value}
        <form onsubmit={sendMessage} class="grow flex flex-col">
          {#if replyingTo}
            <div
              class="flex justify-between bg-violet-800 text-white rounded-t-lg px-4 py-2"
            >
              <div class="flex flex-col gap-1">
                <h5 class="flex gap-2 items-center">
                  Replying to
                  <Avatar.Root class="w-4">
                    <Avatar.Image
                      src={replyingTo.profile.avatarUrl}
                      class="rounded-full"
                    />
                    <Avatar.Fallback>
                      <AvatarBeam name={replyingTo.profile.handle} />
                    </Avatar.Fallback>
                  </Avatar.Root>
                  <strong>{replyingTo.profile.handle}</strong>
                </h5>
                <p class="text-gray-300 text-ellipsis italic">
                  {@html renderMarkdownSanitized(replyingTo.content)}
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
          <input
            type="text"
            class={`w-full px-4 py-2 flex-none text-white bg-violet-900 ${replyingTo ? "rounded-b-lg" : "rounded-lg"}`}
            placeholder="Say something..."
            bind:value={messageInput}
          />
        </form>
      {/if}

      {#if isMobile}
        {@render toolbar({ growButton: true })}
      {/if}
    </div>
  {/if}
{/snippet}

{#snippet threadsTab()}
  {#if space}
    {#if currentThread}
      <section class="flex flex-col gap-4 items-start">
        <menu class="px-4 py-2 flex w-full justify-between">
          <Button.Root
            onclick={() => goto(page.url.pathname)}
            class="flex gap-2 items-center text-white cursor-pointer hover:scale-105 transitiona-all duration-150"
          >
            <Icon icon="uil:left" />
            Back
          </Button.Root>
          <Dialog.Root>
            <Dialog.Trigger
              class="hover:scale-105 active:scale-95 transition-all duration-150 cursor-pointer"
            >
              <Icon icon="tabler:trash" color="red" class="text-2xl" />
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Overlay
                transition={fade}
                transitionConfig={{ duration: 150 }}
                class="fixed inset-0 z-50 bg-black/80"
              />
              <Dialog.Content
                class="fixed p-5 flex flex-col text-white gap-4 w-dvw max-w-(--breakpoint-sm) left-[50%] top-[50%] z-50 translate-x-[-50%] translate-y-[-50%] rounded-lg border bg-purple-950"
              >
                <Dialog.Title
                  class="text-bold font-bold text-xl flex items-center justify-center gap-4"
                >
                  <Icon
                    icon="ri:alarm-warning-fill"
                    color="red"
                    class="text-2xl"
                  />
                  <span> Delete Thread </span>
                  <Icon
                    icon="ri:alarm-warning-fill"
                    color="red"
                    class="text-2xl"
                  />
                </Dialog.Title>
                <Separator.Root class="border border-white" />
                <div class="flex flex-col items-center gap-4">
                  <p>The thread will be unrecoverable once deleted.</p>
                  <Button.Root
                    onclick={() =>
                      deleteThread(page.url.searchParams.get("thread")!)}
                    class="flex items-center gap-3 px-4 py-2 max-w-[20em] bg-red-600 text-white rounded-lg hover:scale-[102%] active:scale-95 transition-all duration-150"
                  >
                    Confirm Delete
                  </Button.Root>
                </div>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        </menu>

        {#each currentThread.timeline as id}
          <ChatMessage {id} messages={space.view.messages} />
        {/each}
      </section>
    {:else}
      <ul class="overflow-y-auto px-2 gap-3 flex flex-col">
        {#each Object.entries(space.view.threads) as [id, thread] (id)}
          <ThreadRow
            {id}
            {thread}
            onclick={() => goto(`?thread=${id}`)}
            onclickDelete={() => deleteThread(id)}
          />
        {/each}
      </ul>
    {/if}
  {/if}
{/snippet}

{#snippet toolbar({ growButton = false }: { growButton: boolean })}
  {#if isThreading.value}
    <div in:fly class={`${growButton && "grow w-full pr-2"}`}>
      <Popover.Root>
        <Popover.Trigger
          class={`cursor-pointer ${growButton ? "w-full" : "w-fit"} px-4 py-2 rounded bg-violet-800 text-white`}
        >
          Create Thread
        </Popover.Trigger>

        <Popover.Content
          transition={fly}
          sideOffset={8}
          class="bg-violet-800 p-4 rounded"
        >
          <form
            onsubmit={createThread}
            class="text-white flex flex-col gap-4"
          >
            <label class="flex flex-col gap-1">
              Thread Title
              <input
                bind:value={threadTitleInput}
                type="text"
                placeholder="Notes"
                class="border px-4 py-2 rounded"
              />
            </label>
            <Popover.Close>
              <button
                type="submit"
                class="text-black px-4 py-2 bg-white rounded w-full text-center"
              >
                Confirm
              </button>
            </Popover.Close>
          </form>
        </Popover.Content>
      </Popover.Root>
    </div>
  {/if}
  <menu class="relative flex items-center gap-2 px-2 w-fit self-end">
    <Toggle.Root
      bind:pressed={isThreading.value}
      disabled={tab !== "chat"}
      class={`p-2 ${isThreading.value && "bg-white/10"} cursor-pointer hover:scale-105 active:scale-95 transition-all duration-150 rounded`}
    >
      <Icon
        icon="tabler:needle-thread"
        color={tab !== "chat" ? "gray" : "white"}
        class="text-2xl"
      />
    </Toggle.Root>
    <Button.Root
      title="Copy invite link"
      class="cursor-pointer hover:scale-105 active:scale-95 transition-all duration-150"
      onclick={() => {
        navigator.clipboard.writeText(`${page.url.href}`);
      }}
    >
      <Icon icon="icon-park-outline:copy-link" color="white" class="text-2xl" />
    </Button.Root>
  </menu>
{/snippet}