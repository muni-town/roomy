<script lang="ts" module>
  import type { Message as MessageType } from "./types";

  export const chatArea = $state({
    scrollToMessage: null as ((id: string) => void) | null,
  });

  // Re-export Message type for backwards compatibility
  export type { MessageType as Message };
</script>

<script lang="ts">
  import { ScrollArea } from "bits-ui";
  import ChatMessage from "./message/ChatMessage.svelte";
  import MobileMessageDrawer from "./message/MobileMessageDrawer.svelte";
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
  import { messagingState } from "./TimelineView.svelte";
  import type { Message } from "./types";
  import QueryBoundary from "$lib/components/primitives/QueryBoundary.svelte";

  let {
    messagingState: messagingStateProp,
    virtualizer = $bindable(),
  }: {
    messagingState?: MessagingState;
    virtualizer?: VirtualizerHandle;
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
        'authorHandle', u.handle,
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
          left join comp_embed_image i on i.entity = me.id
          left join comp_embed_video v on v.entity = me.id
          left join comp_embed_file f on f.entity = me.id
          where me.room = e.id
            and (i.entity is not null or v.entity is not null or f.entity is not null)
        ),
        'links', (
          select json_group_array(json_object(
            'uri', l.entity,
            'showPreview', l.show_preview
          ))
          from comp_embed_link l
          where l.entity = e.id
        ),
        'comment', (
          select json_object(
            'snippet', cc.snippet,
            'version', cc.version,
            'from', cc.idx_from,
            'to', cc.idx_to
          )
        ),
        'forwardedFrom', null
      ) as json, e.sort_idx as sort_idx, e.id as msg_id, author_edge.*
      from entities e -- message
        join comp_content c on c.entity = e.id -- message content
        join edges author_edge on author_edge.head = e.id and author_edge.label = 'author' -- message author relation
        left join comp_user u on u.did = author_edge.tail -- author user
        left join comp_info i on i.entity = author_edge.tail -- author info
        left join comp_override_meta o on o.entity = e.id -- overridden author/timestamp
        left join comp_info oai on oai.entity = o.author -- overridden author info
        left join comp_user oau on oau.did = o.author -- overridden author user
        left join comp_comment cc on cc.entity = e.id -- comment
      where
        e.room = ${page.params.object}
          and
        c.data is not null

        union all
  
        -- Forwarded messages: follow forward edge to get original message content
        select json_object(
          'id', fwd.id,
          'content', cast(c.data as text),
          'lastEdit', c.last_edit,
          'authorDid', u.did,
          'authorName', i.name,
          'authorAvatar', i.avatar,
          'authorHandle', u.handle,
          'masqueradeAuthor', o.author,
          'masqueradeTimestamp', o.timestamp,
          'replyTo', coalesce((
            select json_group_array(ed.tail)
            from edges ed
            where ed.head = orig.id and ed.label = 'reply'
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
            where rc.entity = orig.id
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
            left join comp_embed_image i on i.entity = me.id
            left join comp_embed_video v on v.entity = me.id
            left join comp_embed_file f on f.entity = me.id
            where me.room = orig.id
              and (i.entity is not null or v.entity is not null or f.entity is not null)
          ),
          'links', (
            select json_group_array(json_object(
              'uri', l.entity,
              'showPreview', l.show_preview
            ))
            from comp_embed_link l
            where l.entity = orig.id
          ),
          'comment', (
            select json_object(
              'snippet', cc.snippet,
              'version', cc.version,
              'from', cc.idx_from,
              'to', cc.idx_to
            )
            from comp_comment cc
            where cc.entity = orig.id
          ),
          'forwardedFrom', orig.id
        ) as json, fwd.sort_idx as sort_idx, fwd.id as msg_id, author_edge.*
        from entities fwd -- forward reference entity
          join edges fwd_edge on fwd_edge.head = fwd.id and fwd_edge.label = 'forward' -- forward edge
          join entities orig on orig.id = fwd_edge.tail -- original message
          join comp_content c on c.entity = orig.id -- original message content
          join edges author_edge on author_edge.head = orig.id and author_edge.label = 'author' -- original author
          left join comp_user u on u.did = author_edge.tail
          left join comp_info i on i.entity = author_edge.tail
          left join comp_override_meta o on o.entity = orig.id
          left join comp_info oai on oai.entity = o.author
          left join comp_user oau on oau.did = o.author
        where
          fwd.room = ${page.params.object}

      order by sort_idx desc, msg_id desc
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

  // Expose the raw query state for boundary to use
  let queryState = $derived(query.current);

  let timeline = $derived.by(() => {
    const results = query.result;
    if (!results) return [];

    const mapped = results.reverse().map((message, index) => {
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
  let isShowingFirstMessage = $derived(!timeline.length);
  let viewport: HTMLDivElement = $state(null!);

  // Track initial load for auto-scroll
  let hasInitiallyScrolled = $state(false);
  let lastTimelineLength = $state(0);

  // Lifted state for editing messages
  let editingMessageId = $state("");

  // Mobile drawer state - lifted out of virtualized items
  let mobileMenuMessage = $state<Message | null>(null);
  let isMobileDrawerOpen = $state(false);

  function openMobileMenu(message: Message) {
    mobileMenuMessage = message;
    isMobileDrawerOpen = true;
  }

  function handleMobileStartThreading() {
    if (mobileMenuMessage) {
      messagingState.startThreading(mobileMenuMessage);
    }
    isMobileDrawerOpen = false;
  }

  function handleMobileEditMessage() {
    if (mobileMenuMessage) {
      editingMessageId = mobileMenuMessage.id;
    }
    isMobileDrawerOpen = false;
  }

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
    <ScrollArea.Viewport
      bind:ref={viewport}
      class="relative max-w-full w-full h-full"
      onscroll={handleScroll}
    >
      <div class="flex flex-col w-full h-full pb-16 pt-2">
        <QueryBoundary
          query={queryState}
          emptyMessage="No messages here yet. This is the beginning of something beautiful."
          showEmptyState={isShowingFirstMessage}
        >
          {#snippet children()}
            <ol class="flex flex-col gap-2 max-w-full">
              {#key viewport}
                {#if timeline.length > 0}
                  <Virtualizer
                    bind:this={virtualizer}
                    data={timeline}
                    scrollRef={viewport}
                    overscan={5}
                    shift={isShifting}
                    getKey={(x) => {
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
                          messagingState={messagingStateProp}
                          onOpenMobileMenu={openMobileMenu}
                          {editingMessageId}
                          onStartEdit={(id) => (editingMessageId = id)}
                          onCancelEdit={() => (editingMessageId = "")}
                        />
                      {/if}
                    {/snippet}
                  </Virtualizer>
                {/if}
              {/key}
            </ol>
          {/snippet}
        </QueryBoundary>
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
    message={mobileMenuMessage}
    bind:open={isMobileDrawerOpen}
    onStartThreading={handleMobileStartThreading}
    onEditMessage={handleMobileEditMessage}
  />
</div>
