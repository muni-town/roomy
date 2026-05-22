<script lang="ts">
  import { ScrollArea } from "bits-ui";
  import ChatMessage from "./ChatMessage.svelte";
  import MobileMessageDrawer from "./MobileMessageDrawer.svelte";
  import { Virtualizer, type VirtualizerHandle } from "virtua/svelte";
  import { setContext } from "svelte";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import { IconArrowDown, IconLoading } from "@roomy/design/icons";
  import ChatMessageSkeleton from "@roomy/design/components/content/thread/message/ChatMessageSkeleton.svelte";
  import { createMessagesQuery, type Message } from "$lib/queries/messages";
  import { auth } from "$lib/auth.svelte";
  import { transport, cache } from "@roomy-space/sdk";
  import { queryClient } from "$lib/client";
  import { px } from "$lib/auth.svelte";

  const { agentQuery } = transport;
  const { queryKey } = cache;

  type Props = {
    spaceId: string;
    roomId: string;
  };

  let { spaceId, roomId }: Props = $props();

  const messagesQuery = createMessagesQuery(() => roomId);
  const currentUserDid = $derived(auth.session?.did);

  let virtualizer: VirtualizerHandle = $state(null!);
  let viewport: HTMLDivElement = $state(null!);
  let isAtBottom = $state(true);
  let hasInitiallyScrolled = $state(false);
  let prevMessageCount = $state(0);
  let isLoadingOlder = $state(false);
  let isShifting = $state(false);
  let olderCursor = $state<string | null>(null);
  let hasMore = $state(true);

  // Lifted state for editing messages
  let editingMessageId = $state<string | undefined>(undefined);

  // Mobile drawer state
  let mobileMenuMessage = $state<Message | null>(null);
  let isMobileDrawerOpen = $state(false);

  function openMobileMenu(message: Message) {
    mobileMenuMessage = message;
    isMobileDrawerOpen = true;
  }

  // Compute chronological order + mergeWithPrevious from the query data
  let timeline = $derived.by(() => {
    const data = messagesQuery.data;
    if (!data) return [];

    // Data arrives oldest-first (ascending) from the appserver and from the
    // SDK's applyMessageDiff — already chronological, so use it as-is.
    const chronological = data;

    return chronological.map((message, index) => {
      const prev = index > 0 ? chronological[index - 1] : null;
      let mergeWithPrevious = false;
      if (
        prev &&
        message.authorDid &&
        prev.authorDid === message.authorDid &&
        !message.replyTo &&
        new Date(message.timestamp || 0).getTime() -
          new Date(prev.timestamp || 0).getTime() <
          1000 * 60 * 5
      ) {
        mergeWithPrevious = true;
      }
      return { ...message, mergeWithPrevious };
    });
  });

  let showJumpToPresent = $derived(!isAtBottom);

  // Initialize cursor from the first query response
  $effect(() => {
    if (messagesQuery.data && olderCursor === null) {
      // The initial query returns the first page; cursor for older messages
      // is the id of the oldest message in the current window
      // We track `hasMore` based on whether the appserver returned a cursor
      // For now, assume there might be more
    }
  });

  async function loadOlderMessages() {
    if (isLoadingOlder || !hasMore) return;
    const data = messagesQuery.data;
    if (!data || data.length === 0) return;

    isLoadingOlder = true;
    isShifting = true;

    try {
      // Cache is oldest-first, so the oldest message is at index 0.
      const oldestId = data[0]?.id;
      const res = await agentQuery(
        px(),
        "space.roomy.room.getMessages",
        {
          roomId,
          limit: "50",
          cursor: oldestId,
        },
      );

      const olderMessages = res.messages as Message[];
      const newCursor = res.cursor as string | null;

      if (olderMessages.length === 0) {
        hasMore = false;
      } else {
        // Prepend older messages to the TanStack cache. The cache is
        // oldest-first, and `olderMessages` (also oldest-first) are all
        // older than the current window, so they go at the front.
        const key = queryKey("space.roomy.room.getMessages", { roomId });
        queryClient.setQueryData<Message[]>(key, (existing) => {
          if (!existing) return olderMessages;
          const existingIds = new Set(existing.map((m) => m.id));
          const deduped = olderMessages.filter((m) => !existingIds.has(m.id));
          return [...deduped, ...existing];
        });

        if (olderMessages.length < 50) {
          hasMore = false;
        }
      }

      olderCursor = newCursor;

      // Keep shift enabled briefly after load completes to allow rendering
      setTimeout(() => {
        isShifting = false;
      }, 500);
    } catch (e) {
      console.error("Failed to load older messages:", e);
      isShifting = false;
    } finally {
      isLoadingOlder = false;
    }
  }

  function scrollToBottom() {
    if (!virtualizer || timeline.length === 0) return;
    virtualizer.scrollToIndex(timeline.length - 1, { align: "start" });
    isAtBottom = true;
  }

  function handleScroll() {
    if (!viewport) return;
    const { scrollTop, scrollHeight, clientHeight } = viewport;
    isAtBottom = scrollHeight - (scrollTop + clientHeight) < 500;
  }

  function scrollToMessage(id: string) {
    const idx = timeline.findIndex((m) => m.id === id);
    if (idx >= 0) virtualizer?.scrollToIndex(idx);
  }

  setContext("scrollToMessage", scrollToMessage);

  // Initial scroll to bottom when messages first load
  $effect(() => {
    if (
      !hasInitiallyScrolled &&
      messagesQuery.data &&
      messagesQuery.data.length > 0 &&
      virtualizer
    ) {
      setTimeout(() => {
        scrollToBottom();
        hasInitiallyScrolled = true;
      }, 200);
    }
  });

  // Auto-scroll when new messages arrive and already at bottom
  $effect(() => {
    const len = timeline.length;
    if (len > prevMessageCount && prevMessageCount > 0 && isAtBottom) {
      scrollToBottom();
    }
    prevMessageCount = len;
  });

  // Reset state on room change
  $effect(() => {
    // Read roomId to make this reactive to room changes
    void roomId;
    hasInitiallyScrolled = false;
    prevMessageCount = 0;
    olderCursor = null;
    hasMore = true;
    isShifting = false;
  });

  function handleVirtualizerScroll(offset: number) {
    if (offset < 100 && timeline.length > 0 && hasMore && !isLoadingOlder) {
      loadOlderMessages();
    }
  }
</script>

<div class="grow min-h-0 relative">
  <!-- Jump to present button -->
  <div class="absolute w-full bottom-4 right-2 z-50 flex justify-center">
    {#if showJumpToPresent}
      <Button onclick={scrollToBottom}>
        <IconArrowDown class="w-4 h-4" />
        Jump to present
      </Button>
    {/if}
  </div>

  <ScrollArea.Root type="auto" class="h-full overflow-hidden">
    <ScrollArea.Viewport
      bind:ref={viewport}
      class="relative max-w-full w-full h-full"
      onscroll={handleScroll}
    >
      <div class="flex flex-col w-full h-full pb-16 pt-2">
        {#if messagesQuery.isPending}
          <div
            class="flex flex-col justify-end w-full h-full bg-transparent"
          >
            <ChatMessageSkeleton />
            <ChatMessageSkeleton lines={3} />
            <ChatMessageSkeleton lines={1} />
            <ChatMessageSkeleton />
            <ChatMessageSkeleton mergeWithPrevious />
          </div>
        {:else if messagesQuery.isError}
          <div class="flex justify-center items-center p-8 text-sm text-red-600">
            Failed to load messages: {messagesQuery.error.message}
          </div>
        {:else if timeline}
          <ol class="flex flex-col justify-end gap-2 max-w-full h-full">
            {#if isLoadingOlder}
              <div class="flex justify-center py-2">
                <IconLoading class="animate-spin text-base-500" />
              </div>
            {/if}

            {#if timeline.length === 0}
              <p class="opacity-80 p-4 text-center text-sm">
                No messages here yet. This is the beginning of something
                beautiful.
              </p>
            {/if}

            {#if timeline.length > 0 && viewport}
              <Virtualizer
                bind:this={virtualizer}
                data={timeline}
                scrollRef={viewport}
                overscan={5}
                shift={isShifting}
                getKey={(x) => x.id}
                onscroll={handleVirtualizerScroll}
              >
                {#snippet children(message?: Message & { mergeWithPrevious?: boolean })}
                  {#if message}
                    <ChatMessage
                      {spaceId}
                      {roomId}
                      message={message}
                      currentUserDid={currentUserDid}
                      editingMessageId={editingMessageId}
                      onStartEdit={(id) => (editingMessageId = id)}
                      onCancelEdit={() => (editingMessageId = undefined)}
                      onOpenMobileMenu={openMobileMenu}
                      mergeWithPrevious={message.mergeWithPrevious}
                    />
                  {/if}
                {/snippet}
              </Virtualizer>
            {/if}
          </ol>
        {/if}
      </div>
    </ScrollArea.Viewport>
    <ScrollArea.Scrollbar
      orientation="vertical"
      class="flex h-full w-2.5 touch-none select-none rounded-full border-l border-l-transparent p-px transition-all hover:w-3 hover:bg-dark-10 mr-1"
    >
      <ScrollArea.Thumb
        class="relative flex-1 rounded-full bg-accent-300 dark:bg-accent-950 transition-opacity"
      />
    </ScrollArea.Scrollbar>
    <ScrollArea.Corner />
  </ScrollArea.Root>

  <!-- Mobile drawer - outside virtualizer so it doesn't get recycled -->
  <MobileMessageDrawer
    spaceId={spaceId}
    roomId={roomId}
    message={mobileMenuMessage}
    bind:open={isMobileDrawerOpen}
    canEditDelete={mobileMenuMessage?.authorDid === currentUserDid}
    onStartEdit={(id) => (editingMessageId = id)}
  />
</div>
