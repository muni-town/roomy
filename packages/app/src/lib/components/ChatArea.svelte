<script lang="ts" module>
  export const chatArea = $state({
    scrollToMessage: null as ((id: string) => void) | null,
  });
</script>

<script lang="ts">
  import { ScrollArea } from "bits-ui";
  import ChatMessage from "./message/ChatMessage.svelte";
  import { Virtualizer } from "virtua/svelte";
  import { setContext } from "svelte";
  import { page } from "$app/state";
  import { co } from "jazz-tools";
  import type { RoomyEntity } from "@roomy-chat/sdk";
  import Icon from "@iconify/svelte";
  import toast from "svelte-french-toast";
  import { Button } from "@fuxui/base";

  let {
    timeline,
    virtualizer = $bindable(),
    isAdmin = false,
    space,
    threadId,
    allowedToInteract,
    threading,
  }: {
    timeline: string[];
    virtualizer?: Virtualizer<string>;
    isAdmin?: boolean;
    space: co.loaded<typeof RoomyEntity> | undefined | null;
    threadId?: string;
    allowedToInteract?: boolean;
    threading?: { active: boolean; selectedMessages: string[] };
  } = $props();

  let messagesLoaded = $derived(timeline && timeline.length >= 0);
  let showLastN = $state(50);
  let isAtBottom = $state(true);
  let showJumpToPresent = $derived(!isAtBottom && timeline.length > 0);

  let slicedTimeline = $derived(timeline.slice(-showLastN));

  let isShowingFirstMessage = $derived(showLastN >= timeline.length);
  let viewport: HTMLDivElement = $state(null!);

  // Track initial load for auto-scroll
  let hasInitiallyScrolled = $state(false);
  let lastTimelineLength = $state(0);

  function scrollToBottom() {
    if (!virtualizer) return;
    virtualizer.scrollToIndex(timeline.length - 1, { align: "start" });
    isAtBottom = true;
  }

  function handleScroll() {
    if (!viewport || !virtualizer) return;

    const { scrollTop, scrollHeight, clientHeight } = viewport;
    const isNearBottom = scrollHeight - (scrollTop + clientHeight) < 500;
    isAtBottom = isNearBottom;
  }

  function scrollToMessage(id: string) {
    const idx = slicedTimeline.indexOf(id);
    if (idx >= 0) virtualizer?.scrollToIndex(idx);
    else {
      toast.error("Message not found");
    }
  }

  setContext("scrollToMessage", scrollToMessage);

  // Handle route changes and initial load - scroll to bottom once
  $effect(() => {
    page.route; // Trigger on route changes
    hasInitiallyScrolled = false; // Reset for new route
  });

  // Simple initial scroll to bottom when timeline first loads
  $effect(() => {
    if (!hasInitiallyScrolled && timeline.length > 0 && virtualizer) {
      setTimeout(() => {
        scrollToBottom();
        hasInitiallyScrolled = true;
      }, 200);
    }
    chatArea.scrollToMessage = scrollToMessage;
  });

  // Handle new messages - only auto-scroll if user is at bottom
  $effect(() => {
    if (timeline.length > lastTimelineLength && lastTimelineLength > 0) {
      if (isAtBottom && virtualizer) {
        setTimeout(() => scrollToBottom(), 50);
      }
    }
    lastTimelineLength = timeline.length;
  });

  let isShifting = $state(false);
</script>

{#if showJumpToPresent}
  <Button
    class="absolute bottom-6 left-1/2 -translate-x-1/2 z-50"
    onclick={scrollToBottom}
  >
    <Icon icon="tabler:arrow-down" class="w-4 h-4" />
    Jump to present
  </Button>
{/if}

<div class="relative h-full">
  <ScrollArea.Root type="scroll" class="h-full overflow-hidden">
    {#if !messagesLoaded}
      <!-- Important: This area takes the place of the chat which pushes chat offscreen
        which allows it to load then pop into place once the spinner is gone. -->
      <div
        class="grid items-center justify-center h-full w-full bg-transparent"
      >
        <span class="dz-loading dz-loading-spinner"></span>
      </div>
    {/if}
    <ScrollArea.Viewport
      bind:ref={viewport}
      class="relative max-w-full w-full h-full"
      onscroll={handleScroll}
    >
      <div class="flex flex-col w-full h-full pb-16 pt-2">
        {#if slicedTimeline.length < timeline.length}
          <Button
            class="w-fit mx-auto mb-2"
            onclick={() => {
              isShifting = true;
              showLastN += 100;
              setTimeout(() => {
                isShifting = false;
              }, 1000);
            }}
            >Load More
          </Button>
        {/if}
        {#if isShowingFirstMessage}
          <div class="flex flex-col gap-2 max-w-full px-6 mb-4 mt-4">
            <p class="text-base font-semibold text-base-900 dark:text-base-100">Hello world!</p>
            <p class="text-sm text-base-600 dark:text-base-400">This is the beginning of something beautiful.</p>
          </div>
        {/if}
        <ol class="flex flex-col gap-2 max-w-full">
          <!--
        This use of `key` needs explaining. `key` causes the components below
        it to be deleted and re-created when the expression passed to it is changed.
        This means that every time the `viewport` binding si updated, the virtualizer
        will be re-created. This is important because the virtualizer only actually sets
        up the scrollRef when is mounted. And `viewport` is technically only assigned after
        _this_ parent component is mounted. Leading to a chicken-egg problem.

        Once the `viewport` is assigned, the virtualizer has already been mounted with scrollRef
        set to `undefined`, and it won't be re-calculated.

        By using `key` we make sure that the virtualizer is re-mounted after the `viewport` is
        assigned, so that it's scroll integration works properly.
      -->

          {#key viewport}
            <Virtualizer
              bind:this={virtualizer}
              data={slicedTimeline || []}
              getKey={(messageId) => messageId}
              scrollRef={viewport}
              overscan={5}
              shift={isShifting}
            >
              {#snippet children(messageId: string, index: number)}
                <ChatMessage
                  {messageId}
                  previousMessageId={slicedTimeline[index - 1]}
                  {isAdmin}
                  {space}
                  {threadId}
                  {allowedToInteract}
                  {threading}
                />
              {/snippet}
            </Virtualizer>
          {/key}
        </ol>
      </div>
    </ScrollArea.Viewport>
    <ScrollArea.Scrollbar
      orientation="vertical"
      class="flex h-full w-2.5 touch-none select-none rounded-full border-l border-l-transparent p-px transition-all hover:w-3 hover:bg-dark-10 mr-1"
    >
      <ScrollArea.Thumb
        class="relative flex-1 rounded-full bg-base-300 transition-opacity"
      />
    </ScrollArea.Scrollbar>
    <ScrollArea.Corner />
  </ScrollArea.Root>
</div>
