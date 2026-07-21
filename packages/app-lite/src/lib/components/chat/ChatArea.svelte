<script lang="ts">
  import { ScrollArea } from "bits-ui";
  import ChatMessage from "./ChatMessage.svelte";
  import MobileMessageDrawer from "./MobileMessageDrawer.svelte";
  import { Virtualizer, type VirtualizerHandle } from "virtua/svelte";
  import { setContext, onMount } from "svelte";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import { IconArrowDown, IconLoading } from "@roomy/design/icons";
  import ErrorMessage from "@roomy/design/components/helper/ErrorMessage.svelte";
  import ChatMessageSkeleton from "@roomy/design/components/content/thread/message/ChatMessageSkeleton.svelte";
  import { createMessagesQuery, type Message } from "$lib/queries/messages";
  import { auth } from "$lib/auth.svelte";
  import { cache } from "@roomy-space/sdk";
  import { queryClient } from "$lib/client";
  import { px } from "$lib/auth.svelte";
  import { scrollPositionState } from "./scroll-position.svelte";

  const { queryKey } = cache;

  type Props = {
    spaceId: string;
    roomId: string;
    onSeen?: () => void;
  };
  
  let { spaceId, roomId, onSeen }: Props = $props();

  const messagesQuery = createMessagesQuery(() => roomId);
  const currentUserDid = $derived(auth.userDid);

  let virtualizer: VirtualizerHandle = $state(null!);
  let viewport: HTMLDivElement = $state(null!);
  let isAtBottom = $state(true);
  let prevIsAtBottom = $state(true);
  let prevMessageCount = $state(0);
  let isLoadingOlder = $state(false);
  let isShifting = $state(false);
  let olderCursor = $state<string | null>(null);
  let hasMore = $state(true);
  let currentScrollOffset = $state(0);
  let lastRestoredRoomId = $state<string | null>(null);
  let isRestoring = $state(false); // Track when we're actively restoring scroll position

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
      const res = await px().query(
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
    // Clear saved position when explicitly scrolling to bottom
    scrollPositionState.clear(roomId);
  }

  function handleScroll() {
    if (!viewport || isRestoring) return;
    const { scrollTop, scrollHeight, clientHeight } = viewport;
    isAtBottom = scrollHeight - (scrollTop + clientHeight) < 500;
    currentScrollOffset = scrollTop;
  
    // Detect transition to bottom — user scrolled down past unread messages
    if (isAtBottom && !prevIsAtBottom && !isRestoring) {
      onSeen?.();
    }
    prevIsAtBottom = isAtBottom;
  
    // Update scroll position state when user scrolls
    if (timeline.length > 0) {
      if (isAtBottom) {
        // Clear saved position when user scrolls to bottom
        scrollPositionState.clear(roomId);
      } else {
        scrollPositionState.set(roomId, {
          offset: scrollTop,
          atBottom: isAtBottom,
          timestamp: Date.now(),
        });
      }
    }
  }

  function scrollToMessage(id: string) {
    const idx = timeline.findIndex((m) => m.id === id);
    if (idx >= 0) virtualizer?.scrollToIndex(idx);
  }

  setContext("scrollToMessage", scrollToMessage);

  // Save scroll position before component unmounts (e.g., when switching views)
  onMount(() => {
    return () => {
      // Cleanup: save final scroll position before unmounting
      if (viewport && timeline.length > 0 && currentScrollOffset > 0) {
        const { scrollHeight, clientHeight, scrollTop } = viewport;
        const atBottom = scrollHeight - (scrollTop + clientHeight) < 500;

        if (!atBottom) {
          scrollPositionState.set(roomId, {
            offset: currentScrollOffset,
            atBottom,
            timestamp: Date.now(),
          });
        }
      }
    };
  });

  // Restore scroll position or scroll to bottom when messages first load for each room
  $effect(() => {
    // Track roomId directly - effect runs when roomId changes
    const currentRoomId = roomId;
    const data = messagesQuery.data;

    // Only restore if we haven't restored for this specific roomId yet
    if (
      data &&
      data.length > 0 &&
      virtualizer &&
      lastRestoredRoomId !== currentRoomId
    ) {
      const savedPosition = scrollPositionState.get(currentRoomId);

      // Mark that we're attempting to restore for this roomId BEFORE the timeout
      lastRestoredRoomId = currentRoomId;
      isRestoring = true; // Block auto-scroll during restoration

      setTimeout(() => {
        // Double-check that we're still on the same room before restoring
        if (lastRestoredRoomId !== currentRoomId) {
          // Room changed during the timeout, don't restore
          isRestoring = false;
          return;
        }

        if (savedPosition && !savedPosition.atBottom) {
          // Restore to saved scroll position
          viewport?.scrollTo({
            top: savedPosition.offset,
            behavior: 'instant',
          });

          // Update isAtBottom to match the restored position
          isAtBottom = false;
        } else {
          // No saved position or was at bottom, scroll to bottom
          scrollToBottom();
          isAtBottom = true;
        }
        isRestoring = false; // Re-enable auto-scroll after restoration
      }, 200);
    }
  });

  // Auto-scroll when new messages arrive and already at bottom
  // Skip during initial restoration to prevent jumping back to bottom
  $effect(() => {
    if (isRestoring) return; // Don't auto-scroll during restoration

    const len = timeline.length;
    if (len > prevMessageCount && prevMessageCount > 0 && isAtBottom) {
      scrollToBottom();
    }
    prevMessageCount = len;
  });

  // Reset scroll restoration state when roomId changes.
  // Reading roomId here makes the effect (and its cleanup) re-run on change.
  $effect(() => {
    roomId;
    return () => {
      // When roomId changes, reset state for the next room
      // Note: lastRestoredRoomId is NOT reset here - it's set by the restoration effect
      prevMessageCount = 0;
      olderCursor = null;
      hasMore = true;
      isShifting = false;
      currentScrollOffset = 0;
      isRestoring = false;
    };
  });

  function handleVirtualizerScroll(offset: number) {
    // Track scroll position from virtualizer events (more reliable than viewport scroll)
    if (!isRestoring && timeline.length > 0) {
      currentScrollOffset = offset;
  
      // Check if we're at the bottom
      const { scrollHeight, clientHeight } = viewport ?? {};
      if (scrollHeight && clientHeight) {
        isAtBottom = scrollHeight - (offset + clientHeight) < 500;
      }
  
      // Detect transition to bottom — user scrolled down past unread messages
      if (isAtBottom && !prevIsAtBottom && !isRestoring) {
        onSeen?.();
      }
      prevIsAtBottom = isAtBottom;
  
      // Save scroll position proactively
      if (isAtBottom) {
        scrollPositionState.clear(roomId);
      } else {
        scrollPositionState.set(roomId, {
          offset,
          atBottom: isAtBottom,
          timestamp: Date.now(),
        });
      }
    }
  
    // Load older messages when near the top
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
          <ErrorMessage message="Failed to load messages: {messagesQuery.error.message}" class="p-8 justify-center" />
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
