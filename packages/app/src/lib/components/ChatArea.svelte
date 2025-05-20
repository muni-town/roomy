<script lang="ts">
  import { ScrollArea } from "bits-ui";
  import ChatMessage from "./ChatMessage.svelte";
  import { Virtualizer } from "virtua/svelte";
  import { setContext } from "svelte";
  import {
    Announcement,
    Message,
    type EntityIdStr,
    type Timeline,
  } from "@roomy-chat/sdk";
  import { derivePromise } from "$lib/utils.svelte";
  import { page } from "$app/state";
  import { globalState } from "$lib/global.svelte";

  let {
    timeline,
    virtualizer = $bindable(),
  }: {
    timeline: Timeline;
    virtualizer?: Virtualizer<string>;
  } = $props();

  let viewport: HTMLDivElement = $state(null!);
  let messagesLoaded = $state(false);
  let isRestoringScroll = $state(false);
  let scrollPosition = $state(0);
  let isAtBottom = $state(true);
  let showScrollToBottom = $derived(!isAtBottom && messagesLoaded);

  setContext("scrollToMessage", (id: EntityIdStr) => {
    const idx = timeline.timeline.ids().indexOf(id);
    if (idx !== -1 && virtualizer) virtualizer.scrollToIndex(idx);
  });

  const messages = derivePromise([], async () => {
    const items = await timeline.timeline.items();
    messagesLoaded = true;
    return items
      .map((x) => x.tryCast(Message) || x.tryCast(Announcement))
      .filter((x) => !!x);
  });

  $effect(() => {
    page.route; // Scroll-to-end when route changes
    messages.value; // Scroll to end when message list changes.

    if (!viewport || !virtualizer) return;

    // Auto-scroll to bottom if we're already at the bottom or if scroll-to-bottom button is not visible
    if (isAtBottom || !showScrollToBottom) {
      virtualizer.scrollToIndex(messages.value.length - 1, { align: "end" });
    }
  });

  function shouldMergeWithPrevious(
    message: Message | Announcement,
    previousMessage?: Message | Announcement,
  ): boolean {
    const areMessages =
      previousMessage instanceof Message &&
      message instanceof Message &&
      !previousMessage.softDeleted;
    const authorsAreSame =
      areMessages &&
      message.authors((x) => x.get(0)) ==
        previousMessage.authors((x) => x.get(0));
    const messagesWithin5Minutes =
      (message.createdDate?.getTime() || 0) -
        (previousMessage?.createdDate?.getTime() || 0) <
      60 * 1000 * 5;
    const areAnnouncements =
      previousMessage instanceof Announcement &&
      message instanceof Announcement;
    const isSequentialMovedAnnouncement =
      areAnnouncements &&
      previousMessage.kind == "messageMoved" &&
      message.kind == "messageMoved" &&
      previousMessage.relatedThreads.ids()[0] ==
        message.relatedThreads.ids()[0];
    const mergeWithPrevious =
      (authorsAreSame && messagesWithin5Minutes) ||
      isSequentialMovedAnnouncement;
    return mergeWithPrevious;
  }

  $effect(() => {
    if (!messagesLoaded || !virtualizer || !globalState.channel) return;

    // Restore scroll position if available
    const savedPosition = globalState.getScrollPosition(globalState.channel.id);
    console.dir("got scroll position", globalState.channel.id,savedPosition)
    if (savedPosition > 0 && !isRestoringScroll) {
      isRestoringScroll = true;
      // virtualizer.scrollToIndex(0); // First scroll to top
      // requestAnimationFrame(() => {
      //   virtualizer.scrollToIndex(savedPosition, { align: "start" });
      //   isRestoringScroll = false;
      // });
    }
  });

  // Handle scroll events to save position and check if at bottom
  function handleScroll(e: UIEvent) {
    if (!viewport) return;
    
    const { scrollTop, scrollHeight, clientHeight } = viewport;
    const isNearBottom = scrollHeight - scrollTop - clientHeight < 100; // 100px threshold
    if (isNearBottom !== isAtBottom) {
      isAtBottom = isNearBottom;
    }
    
    // Save scroll position
    const currentIndex = Math.floor(scrollTop / 50);
    if (globalState.channel) {
      globalState.saveScrollPosition(globalState.channel.id, currentIndex);
    }
  }
  
  function scrollToBottom() {
    if (virtualizer && messages.value.length > 0) {
      virtualizer.scrollToIndex(messages.value.length - 1, { align: "end" });
      isAtBottom = true;
    }
  }
</script>

<ScrollArea.Root
  type="scroll"
  class="h-full overflow-hidden"
>
  {#if !messagesLoaded}
    <!-- Important: This area takes the place of the chat which pushes chat offscreen
       which allows it to load then pop into place once the spinner is gone. -->
    <div class="grid items-center justify-center h-full w-full bg-transparent">
      <span class="dz-loading dz-loading-spinner"></span>
    </div>
  {/if}

  <ScrollArea.Viewport
    bind:ref={viewport}
    class="relative max-w-full w-full h-full"
    onscroll={handleScroll}
  >
    <div class="flex flex-col-reverse w-full h-full">
      {#if showScrollToBottom}
        <button
          onclick={scrollToBottom}
          class="fixed bottom-20 right-6 z-50 bg-primary text-primary-content px-4 py-2 rounded-full shadow-lg hover:bg-primary-focus transition-colors"
        >
          Scroll to Present
        </button>
      {/if}
      <ol class="flex flex-col gap-2 max-w-ful">
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
            data={messages.value}
            getKey={(message) => message.id}
            scrollRef={viewport}
          >
            {#snippet children(message: Message | Announcement, index: number)}
              {@const previousMessage =
                index > 0 ? messages.value[index - 1] : undefined}
              {#if !message.softDeleted}
                {@const isLinkThread = globalState.channel?.name === "@links"}
                <ChatMessage
                  {message}
                  mergeWithPrevious={!isLinkThread &&
                    shouldMergeWithPrevious(message, previousMessage)}
                  type={isLinkThread ? "link" : "message"}
                />
              {:else}
                <p class="italic text-error text-sm">
                  This message has been deleted
                </p>
              {/if}
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
