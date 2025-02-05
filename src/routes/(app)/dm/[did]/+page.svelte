<script lang="ts">
  import type { Autodoc } from "$lib/autodoc.svelte";
  import ChatArea from "$lib/components/ChatArea.svelte";
  import { g } from "$lib/global.svelte";
  import type { Channel, Thread, Ulid } from "$lib/schemas/types";
  import { page } from "$app/state";
  import { user } from "$lib/user.svelte";
  import { setContext, untrack } from "svelte";
  import { Avatar, Button, Dialog, Popover, Separator, Tabs, Toggle } from "bits-ui";
  import { AvatarBeam } from "svelte-boring-avatars";
  import Icon from "@iconify/svelte";
  import { fade, fly } from "svelte/transition";
  import { ulid } from "ulidx";
  import ThreadRow from "$lib/components/ThreadRow.svelte";
  import { goto } from "$app/navigation";
  import ChatMessage from "$lib/components/ChatMessage.svelte";
  import toast from "svelte-french-toast";

  let tab = $state("chat");
  let channel: Autodoc<Channel> | undefined = $derived(g.dms[page.params.did]);
  let messageInput = $state("");
  let info = $derived(g.catalog?.view.dms[page.params.did]);
  let currentThread = $derived.by(() => {
    if (page.url.searchParams.has("thread")) {
      return channel.view.threads[page.url.searchParams.get("thread")!] as Thread;
    }
    else {
      return null;
    }
  });

  $effect(() => {
    if (currentThread) { tab = "threads" }
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

  // Mark the current DM as read.
  $effect(() => {
    const did = page.params.did!;
    const latestHeads = channel?.heads();
    untrack(() => {
      if (g.catalog?.view.dms[did]?.viewedHeads !== latestHeads) {
        g.catalog?.change((doc) => {
          doc.dms[did].viewedHeads = latestHeads || [];
        });
      }
    });
  });

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
    toast.success("Thread created", { position: "bottom-end" })
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
      };
      doc.timeline.push(id);
    });

    messageInput = "";
  }

  function deleteThread(id: Ulid) {
    if (!channel) return;

    channel.change((doc) => {
      delete doc.threads[id]
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
      <Icon icon="tabler:needle-thread" color={tab !== "chat" ? "gray" : "white"} class="text-2xl" />
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
      <Icon
        icon="icon-park-outline:copy-link"
        color="white"
        class="text-2xl"
      />
    </Button.Root>
    <Button.Root
      class="p-2 cursor-pointer hover:scale-105 active:scale-95 transition-all duration-150"
    >
      <Icon icon="basil:settings-alt-solid" color="white" class="text-2xl" />
    </Button.Root>
  </menu>
</header>

{#if channel}
  {#if tab === "chat"}
    <ChatArea {channel} />
    <form onsubmit={sendMessage}>
      <input
        type="text"
        class="w-full px-4 py-2 rounded-lg bg-violet-900 flex-none text-white"
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
            <Dialog.Trigger class="hover:scale-105 active:scale-95 transition-all duration-150 cursor-pointer">
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
                  <Icon icon="ri:alarm-warning-fill" color="red" class="text-2xl" />
                  <span> Delete Thread </span>
                  <Icon icon="ri:alarm-warning-fill" color="red" class="text-2xl" />
                </Dialog.Title>
                <Separator.Root class="border border-white" />
                <div class="flex flex-col items-center gap-4">
                  <p>
                    The thread will be unrecoverable once deleted.
                  </p>
                  <Button.Root
                    onclick={() => deleteThread(page.url.searchParams.get("thread")!)}
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
          <ChatMessage {id} message={channel.view.messages[id]} />
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