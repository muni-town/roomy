<script lang="ts" module>
  export const chatArea = $state({
    scrollToMessage: null as ((id: string) => void) | null,
  });
</script>

<script lang="ts">
  import { ScrollArea } from "bits-ui";
  import ChatMessage from "./message/ChatMessage.svelte";
  import { Virtualizer, type VirtualizerHandle } from "virtua/svelte";
  import { setContext } from "svelte";
  import { page } from "$app/state";
  import { Button, toast } from "@fuxui/base";

  import IconTablerArrowDown from "~icons/tabler/arrow-down";
  import { LiveQuery } from "$lib/utils/liveQuery.svelte";
  import { sql } from "$lib/utils/sqlTemplate";
  import { decodeTime } from "ulidx";
  import { onNavigate } from "$app/navigation";
  import type { MessagingState } from "./TimelineView.svelte";
  import type { Ulid, UserDid } from "$lib/schema";

  export type Message = {
    id: Ulid;
    content: string;
    lastEdit: Ulid;
    authorDid: UserDid | null;
    authorName: string | null;
    authorHandle: string | null;
    authorAvatar: string | null;
    masqueradeAuthor: string | null;
    masqueradeAuthorHandle: string | null;
    masqueradeTimestamp: string | null;
    masqueradeAuthorName: string | null;
    masqueradeAuthorAvatar: string | null;
    mergeWithPrevious: boolean | null;
    replyTo: Ulid[];
    reactions: {
      reaction: string;
      userId: UserDid;
      userName: string;
      reactionId: Ulid;
    }[];
    media: {
      uri: string;
      mimeType: string;
      width?: number;
      height?: number;
      blurhash?: string;
      length?: number;
      size?: number;
      name?: string;
    }[];
    links: {
      uri: string;
      showPreview: boolean;
    }[];
    comment: {
      snippet?: string;
      version: Ulid;
      from: number;
      to: number;
    };
  };

  let {
    messagingState,
    startThreading,
    virtualizer = $bindable(),
    toggleSelect,
  }: {
    messagingState?: MessagingState;
    startThreading: (message?: Message) => void;
    virtualizer?: VirtualizerHandle;
    toggleSelect: (message: Message) => void;
  } = $props();

  let query = new LiveQuery<Message>(
    () => sql`
      select json_object(
        'id', e.id,
        'content', cast(c.data as text),
        'lastEdit', c.last_edit,
        'authorDid', u.did,
        'authorName', i.name,
        'authorAvatar', i.avatar,
        'masqueradeAuthor', o.author,
        'masqueradeTimestamp', o.timestamp,
        'replyTo', coalesce((
          select json_group_array(ed.tail)
          from edges ed
          where ed.head = e.id and ed.label = 'reply'
        ), json_array()),
        'masqueradeAuthorName', oai.name,
        'masqueradeAuthorAvatar', oai.avatar,
        'masqueradeAuthorHandle', oau.handle,
        'reactions', (
          select json_group_array(json_object(
            'reaction', rc.reaction,
            'userId', rc.user,
            'userName', i.name,
            'reactionId', rc.reaction_id
          ))
          from comp_reaction rc
          join comp_info i on i.entity = rc.user
          where rc.entity = e.id 
        ),
        'media', (
          select json_group_array(json_object(
            'mimeType', coalesce(i.mime_type, v.mime_type, f.mime_type),
            'uri', coalesce(i.entity, v.entity, f.entity),
            'width', coalesce(i.width, v.width),
            'height', coalesce(i.height, v.height),
            'blurhash', coalesce(i.blurhash, v.blurhash),
            'length', v.length,
            'size', coalesce(i.size, v.size, f.size),
            'name', f.name
          ))
          from entities me
          left join comp_image i on i.entity = me.id
          left join comp_video v on v.entity = me.id
          left join comp_file f on f.entity = me.id
          where me.parent = e.id
            and (i.entity is not null or v.entity is not null or f.entity is not null)
        ),
        'links', (
          select json_group_array(json_object(
            'uri', l.entity,
            'showPreview', l.show_preview
          ))
          from comp_link l
          where l.entity = e.id
        ),
        'comment', (
          select json_object(
            'snippet', cc.snippet,
            'version', cc.version,
            'from', cc.idx_from,
            'to', cc.idx_to
          )
        )
      ) as json, author_edge.*
      from entities e
        join comp_content c on c.entity = e.id
        join edges author_edge on author_edge.head = e.id and author_edge.label = 'author'
        left join comp_user u on u.did = author_edge.tail
        left join comp_info i on i.entity = author_edge.tail
        left join comp_override_meta o on o.entity = e.id
        left join comp_info oai on oai.entity = o.author
        left join comp_user oau on oau.did = o.author
        left join comp_comment cc on cc.entity = e.id
      where
        e.parent = ${page.params.object}
      order by e.sort_idx desc, e.id desc
      limit ${showLastN}
    `,
    (row) => {
      return JSON.parse(row.json);
    },
  );

  let showLastN = $state(50);
  onNavigate(() => {
    showLastN = 50;
  });
  let isAtBottom = $state(true);
  let showJumpToPresent = $derived(!isAtBottom);

  let timeline = $derived.by(() => {
    if (!query.result) return [];
    // return query.result;

    const mapped = query.result.reverse().map((message, index) => {
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
        messageNorm.timestamp - (prevMessageNorm?.timestamp || 0) <
          1000 * 60 * 5;

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
  let lastShowLastN = $state(0);
  $effect(() => {
    if (showLastN > lastShowLastN) {
      lastShowLastN = showLastN;
      isShifting = true;
      setTimeout(() => (isShifting = false), 1000);
    }
  });
</script>

<div class="grow min-h-0 relative">
  <div class="absolute w-full bottom-4 right-2 z-50 flex justify-center">
    {#if showJumpToPresent}
      <Button onclick={scrollToBottom}>
        <IconTablerArrowDown class="w-4 h-4" />
        Jump to present
      </Button>
    {/if}
  </div>

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
            {#if timeline.length > 0}
              <Virtualizer
                bind:this={virtualizer}
                data={timeline}
                scrollRef={viewport}
                overscan={5}
                shift={isShifting}
                getKey={(x) => {
                  // Note: for some reason, sometimes `x` and `message` below are
                  // undefined, so we have to use the conditionals to make sure we
                  // don't try access properties of `undefined`.
                  //
                  // It might be good to figure out the root cause and fix that sometime.
                  return x?.id;
                }}
                onscroll={(o) => {
                  if (o < 100) showLastN += 50;
                }}
              >
                {#snippet children(message?: Message)}
                  {#if message}
                    <ChatMessage
                      {message}
                      {messagingState}
                      {startThreading}
                      {toggleSelect}
                    />
                  {/if}
                {/snippet}
              </Virtualizer>
            {/if}
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
