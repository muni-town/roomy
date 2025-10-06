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
  import { Button, toast } from "@fuxui/base";

  import IconTablerArrowDown from "~icons/tabler/arrow-down";
  import { LiveQuery } from "$lib/liveQuery.svelte";
  import { sql } from "$lib/utils/sqlTemplate";
  import { id } from "$lib/workers/encoding";
  import { decodeTime } from "ulidx";

  export type Message = {
    id: string;
    content: string;
    authorDid: string;
    authorName?: string;
    authorHandle?: string;
    authorAvatar?: string;
    masqueradeAuthor?: string;
    masqueradeAuthorHandle?: string;
    masqueradeTimestamp?: string;
    masqueradeAuthorName?: string;
    masqueradeAuthorAvatar?: string;
    mergeWithPrevious?: boolean;
    replyTo?: string;
  };

  let {
    threading,
    startThreading,
    virtualizer = $bindable(),
    toggleSelect,
  }: {
    threading?: { active: boolean; selectedMessages: Message[]; name: string };
    startThreading: (message?: Message) => void;
    virtualizer?: Virtualizer<Message>;
    toggleSelect: (message: Message) => void;
  } = $props();

  let query = new LiveQuery<Message>(
    () => sql`
      select
        id(c.entity) as id,
        cast(c.data as text) as content,
        id(u.did) as authorDid,
        i.name as authorName,
        i.avatar as authorAvatar,
        id(o.author) as masqueradeAuthor,
        o.timestamp as masqueradeTimestamp,
        id(e.tail) as replyTo,
        oai.name as masqueradeAuthorName,
        oai.avatar as masqueradeAuthorAvatar,
        oau.handle as masqueradeAuthorHandle
      from entities e
        join comp_content c on c.entity = e.id
        join edges author_edge on author_edge.head = e.id and author_edge.label = 'author'
        join comp_user u on u.did = author_edge.tail
        join comp_info i on i.entity = author_edge.tail
        left join comp_override_meta o on o.entity = e.id
        left join comp_info oai on oai.entity = o.author
        left join comp_user oau on oau.did = o.author
        left join edges e on e.head = c.entity and e.label = 'reply'
      where
        e.parent = ${page.params.object && id(page.params.object)}
      order by c.entity
    `,
  );

  let showLastN = $state(50);
  let isAtBottom = $state(true);
  let showJumpToPresent = $derived(!isAtBottom);

  let timeline = $derived.by(() => {
    if (!query.result) return [];
    // return query.result;

    const mapped = query.result.map((message, index) => {
      // Get the previous message (if it exists)
      const prevMessage = index > 0 ? query.result![index - 1] : null;

      // Normalize messages for calculating whether or not to merge them
      const prevMessageNorm = prevMessage
        ? {
            author: prevMessage.masqueradeAuthor || prevMessage.authorDid,
            timestamp:
              parseInt(prevMessage.masqueradeTimestamp || "0") ||
              decodeTime(prevMessage.id),
          }
        : undefined;
      const messageNorm = {
        author: message.masqueradeAuthor || message.authorDid,
        timestamp:
          parseInt(message.masqueradeTimestamp || "0") ||
          decodeTime(message.id),
      };

      // Calculate mergeWithPrevious
      let mergeWithPrevious =
        prevMessageNorm?.author == messageNorm.author &&
        messageNorm.timestamp - prevMessageNorm.timestamp < 1000 * 60 * 5;

      return {
        ...message,
        mergeWithPrevious,
      };
    });
    return mapped;
  });
  let slicedTimeline = $derived(timeline.slice(-showLastN));
  let messagesLoaded = $derived(timeline && timeline.length >= 0);

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
    const message = slicedTimeline.find((msg) => id === msg.id);
    if (!message) {
      toast.error("Message not found");
      return;
    }
    const idx = slicedTimeline.indexOf(message);
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

  // // Simple initial scroll to bottom when timeline first loads
  $effect(() => {
    if (!hasInitiallyScrolled && timeline.length > 0 && virtualizer) {
      setTimeout(() => {
        scrollToBottom();
        hasInitiallyScrolled = true;
      }, 200);
    }
    chatArea.scrollToMessage = scrollToMessage;
  });

  // // Handle new messages - only auto-scroll if user is at bottom
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
  <Button class="absolute bottom-18 right-2 z-50" onclick={scrollToBottom}>
    <IconTablerArrowDown class="w-4 h-4" />
    Jump to present
  </Button>
{/if}

<div class="grow min-h-0">
  <ScrollArea.Root type="auto" class="h-full overflow-hidden">
    <!-- Important: This area takes the place of the chat which pushes chat offscreen
        which allows it to load then pop into place once the spinner is gone. -->
    {#if !messagesLoaded}
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
            <p class="text-base font-semibold text-base-900 dark:text-base-100">
              Hello world!
            </p>
            <p class="text-sm text-base-600 dark:text-base-400">
              This is the beginning of something beautiful.
            </p>
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
              data={timeline}
              scrollRef={viewport}
              overscan={5}
              shift={isShifting}
              getKey={(x) => x.id}
            >
              {#snippet children(message: Message)}
                <ChatMessage
                  {message}
                  {threading}
                  {startThreading}
                  {toggleSelect}
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
        class="relative flex-1 rounded-full bg-accent-300 dark:bg-accent-950 transition-opacity"
      />
    </ScrollArea.Scrollbar>
    <ScrollArea.Corner />
  </ScrollArea.Root>
</div>
