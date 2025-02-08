<script lang="ts">
  import type { Autodoc } from "$lib/autodoc/peer";
  import ChatArea from "$lib/components/ChatArea.svelte";
  import { g } from "$lib/global.svelte";
  import type { Channel, Did, Thread, Ulid } from "$lib/schemas/types";
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
  import { unreadCount } from "$lib/utils";
  import { renderMarkdownSanitized } from "$lib/markdown";
  import type { ProfileViewDetailed } from "@atproto/api/dist/client/types/app/bsky/actor/defs";

  let tab = $state("chat");
  let channel: Autodoc<Channel> | undefined = $derived(g.dms[page.params.did]);
  let messageInput = $state("");
  let info = $derived(g.catalog?.view.dms[page.params.did]);
  let currentThread = $derived.by(() => {
    if (page.url.searchParams.has("thread")) {
      return channel.view.threads[
        page.url.searchParams.get("thread")!
      ] as Thread;
    } else {
      return null;
    }
  });

  // Load bluesky profile
  let profile = $state(undefined) as ProfileViewDetailed | undefined;
  $effect(() => {
    if (user.agent && !profile) {
      user.agent.getProfile({ actor: page.params.did }).then((resp) => {
        if (resp.success) {
          profile = resp.data;
        }
      });
    }
  });

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

  setContext(
    "toggleReaction",
    (id: Ulid, reaction: string) => {
      if (!channel) return; 
      
      channel.change((doc) => {
        const did = user.profile.data?.did;
        if (!did) return;

        let reactions = doc.messages[id].reactions[reaction] as Did[];

        if (reactions.includes(did)) {
          doc.messages[id].reactions[reaction] = reactions.filter((actor: Did) => actor !== did);
        }
        else {
          doc.messages[id].reactions[reaction].push(did);
        }
      });
    }
  );

  // Mark the current DM as read.
  $effect(() => {
    const did = page.params.did!;
    const doc = channel?.view;
    untrack(() => {
      const unread = unreadCount(
        doc,
        g.catalog?.view.dms[did]?.viewedHeads || [],
      );
      if (g.catalog?.view.dms[did]?.viewedHeads && doc && unread > 0) {
        // TODO: Find ways to reduce how frequently we write to this, because the size of the
        // catalog grows every time we send / receive a message and update the latest heads.
        g.catalog?.change((doc) => {
          doc.dms[did].viewedHeads = channel.heads();
        });
      }
    });
  });

  function openDirectMessage() {
    if (g.catalog && profile) {
      g.catalog.change((doc) => {
        doc.dms[page.params.did] = {
          name: profile!.handle,
          avatar: profile!.avatar,
        };
      });
    }
  }

  function createThread(e: SubmitEvent) {
    e.preventDefault();
    if (!channel) return;

    channel.change((doc) => {
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
    if (!channel) return;

    channel.change((doc) => {
      if (!user.agent) return;

      const id = ulid();
      doc.messages[id] = {
        author: user.agent.assertDid,
        reactions: {},
        content: messageInput,
        ...(replyingTo && { replyTo: replyingTo.id }),
      };
      doc.timeline.push(id);
    });

    messageInput = "";
    replyingTo = null;
  }

  function deleteThread(id: Ulid) {
    if (!channel) return;

    channel.change((doc) => {
      delete doc.threads[id];
    });

    toast.success("Thread deleted", { position: "bottom-end" });
    goto(page.url.pathname);
  }
</script>

<header class="flex flex-none items-center justify-between border-b-1 pb-4">
  <div class="flex gap-4 items-center">
    <Avatar.Root class="w-8">
      <Avatar.Image src={info?.avatar} class="rounded-full" />
      <Avatar.Fallback>
        <AvatarBeam name={info?.name} />
      </Avatar.Fallback>
    </Avatar.Root>

    <span class="flex gap-2 items-center">
      <h4 class="text-white text-lg font-bold">
        {info?.name}
      </h4>
      {#if currentThread}
        <Icon icon="mingcute:right-line" color="white" />
        <Icon icon="lucide-lab:reel-thread" color="white" />
        <h5 class="text-white text-lg font-bold">
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
        <p>Chat</p>
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
        <p>Threads</p>
      </Tabs.Trigger>
    </Tabs.List>
  </Tabs.Root>

  <menu class="flex items-center gap-2">
    {#if isThreading.value}
      <div in:fly>
        <Popover.Root>
          <Popover.Trigger
            class="cursor-pointer mx-2 px-4 py-2 rounded bg-violet-800 text-white"
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
        navigator.clipboard.writeText(
          `${page.url.protocol}//${page.url.host}/invite/dm/${user.agent?.assertDid}`,
        );
      }}
    >
      <Icon icon="icon-park-outline:copy-link" color="white" class="text-2xl" />
    </Button.Root>
    <Button.Root
      class="p-2 cursor-pointer hover:scale-105 active:scale-95 transition-all duration-150"
    >
      <Icon icon="basil:settings-alt-solid" color="white" class="text-2xl" />
    </Button.Root>
  </menu>
</header>

{#if !channel}
  <div class="flex w-full h-full justify-center items-center">
    <div class="flex flex-col items-center gap-8">
      {#if profile}
        <Avatar.Root class="w-40">
          <Avatar.Image src={profile.avatar} class="rounded-full" />
          <Avatar.Fallback>
            <AvatarBeam name={profile.handle} />
          </Avatar.Fallback>
        </Avatar.Root>

        <h2 class="text-white font-bold text-2xl">
          {profile.displayName} | @{profile.handle}
        </h2>
      {/if}

      <Button.Root
        class="bg-white h-fit font-medium px-4 py-2 flex gap-2 items-center justify-center rounded-lg hover:scale-105 active:scale-95 transition-all duration-150 m-auto"
        onclick={openDirectMessage}
      >
        <Icon icon="ri:add-fill" class="text-lg" />
        Open Direct Message
      </Button.Root>
    </div>
  </div>
{/if}

{#if channel}
  {#if tab === "chat"}
    <ChatArea {channel} />
    <form onsubmit={sendMessage} class="flex flex-col">
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

  <!-- TODO: Render Threads -->
  {#if tab === "threads"}
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
          <ChatMessage {id} {channel} />
        {/each}
      </section>
    {:else}
      <ul class="overflow-y-auto px-2 gap-3 flex flex-col">
        {#each Object.entries(channel.view.threads) as [id, thread] (id)}
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
{/if}
