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
  import { toast } from "@foxui/core";
  import Button from "$lib/components/ui/button/Button.svelte";

  import { IconArrowDown, IconLoading } from "@roomy/design/icons";
  import { LiveQuery } from "$lib/utils/liveQuery.svelte";
  import { sql } from "$lib/utils/sqlTemplate";
  import { onNavigate } from "$app/navigation";
  import type { MessagingState } from "./TimelineView.svelte";
  import { messagingState } from "./TimelineView.svelte";
  import type { Message } from "./types";
  import { mapAsyncState, type AsyncStateWithIdle } from "@roomy/sdk";
  import StateSuspense from "$lib/components/primitives/StateSuspense.svelte";
  import { peer } from "$lib/workers";
  import { getAppState } from "$lib/queries";
  import ErrorModal from "$lib/components/modals/Error.svelte";
  import ChatMessageSkeleton from "./message/ChatMessageSkeleton.svelte";
  const app = getAppState();

  // Lazy loading state (AsyncStateWithIdle pattern)
  let lazyLoadState = $state<AsyncStateWithIdle<{ hasMore: boolean }>>({
    status: "idle",
  });
  const isLazyLoading = $derived(lazyLoadState.status === "loading");
  const hasMoreHistory = $derived(
    lazyLoadState.status !== "success" || lazyLoadState.data.hasMore,
  );

  async function loadMoreMessages() {
    if (lazyLoadState.status === "loading") return;
    if (lazyLoadState.status === "success" && !lazyLoadState.data.hasMore)
      return;
    const spaceId = app.joinedSpace?.id;
    const roomId = app.roomId;
    if (!spaceId || !roomId) return;

    lazyLoadState = { status: "loading" };
    try {
      const result = await tracer.startActiveSpan(
        "Load More Messages (UI)",
        {
          attributes: {
            "space.id": spaceId,
            "room.id": roomId,
          },
        },
        async (span) => {
          const result = await peer.lazyLoadRoom(spaceId, roomId);
          span.setAttribute("has.more", result.hasMore);
          span.end();
          return result;
        },
      );
      lazyLoadState = { status: "success", data: result };
    } catch (e) {
      lazyLoadState = {
        status: "error",
        message: e instanceof Error ? e.message : "Failed to load messages",
      };
    }
  }

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
        -- Canonical author (resolved by materializer - author edge points to override if present)
        'authorDid', author_edge.tail,
        'authorName', i.name,
        'authorAvatar', i.avatar,
        'authorHandle', u.handle,
        -- Canonical timestamp from comp_content (already resolved by materializer)
        'timestamp', c.timestamp,
        -- Simple bridged flag (check if author DID is from Discord)
        'isBridged', author_edge.tail like 'did:discord:%',
        'replyTo', coalesce((
          select json_group_array(ed.tail)
          from edges ed
          where ed.head = e.id and ed.label = 'reply'
        ), json_array()),
        'reactions', (
          select json_group_array(json_object(
            'reaction', rc.reaction,
            'userId', rc.user,
            'userName', ri.name,
            'reactionId', rc.reaction_id
          ))
          from comp_reaction rc
          left join comp_info ri on ri.entity = rc.user
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
        'forwardedFrom', null,
        'tags', (
          select json_group_array(json_object(
            'snowflake', case
              when te.tail like 'did:discord:%' then substr(te.tail, 13)
              else cdo.snowflake
            end,
            'name', ti.name,
            'handle', tu.handle,
            'roomId', case when te.tail not like 'did:discord:%' then te.tail else null end
          ))
          from edges te
          left join comp_info ti on ti.entity = te.tail
          left join comp_user tu on tu.did = te.tail
          left join comp_discord_origin cdo on cdo.entity = te.tail
          where te.head = e.id and te.label = 'tag'
        )
      ) as json, c.timestamp as canonical_timestamp, e.id as msg_id
      from entities e -- message
        join comp_content c on c.entity = e.id -- message content
        join edges author_edge on author_edge.head = e.id and author_edge.label = 'author' -- message author relation (already resolved by materializer)
        left join comp_user u on u.did = author_edge.tail -- author user
        left join comp_info i on i.entity = author_edge.tail -- author info
        left join comp_comment cc on cc.entity = e.id -- comment
      where
        e.room = ${page.params.object}
          and
        c.data is not null
          and
        c.timestamp is not null -- Filter out messages without timestamps (e.g., system messages)

        union all

        -- Forwarded messages: follow forward edge to get original message content
        select json_object(
          'id', fwd.id,
          'content', cast(c.data as text),
          'lastEdit', c.last_edit,
          -- Canonical author (resolved by materializer - author edge points to override if present)
          'authorDid', author_edge.tail,
          'authorName', i.name,
          'authorAvatar', i.avatar,
          'authorHandle', u.handle,
          -- Canonical timestamp from comp_content (already resolved by materializer)
          'timestamp', c.timestamp,
          -- Simple bridged flag (check if author DID is from Discord)
          'isBridged', author_edge.tail like 'did:discord:%',
          'replyTo', coalesce((
            select json_group_array(ed.tail)
            from edges ed
            where ed.head = orig.id and ed.label = 'reply'
          ), json_array()),
          'reactions', (
            select json_group_array(json_object(
              'reaction', rc.reaction,
              'userId', rc.user,
              'userName', ri.name,
              'reactionId', rc.reaction_id
            ))
            from comp_reaction rc
            join comp_info ri on ri.entity = rc.user
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
          'forwardedFrom', orig.id,
          'tags', (
            select json_group_array(json_object(
              'snowflake', case
                when te.tail like 'did:discord:%' then substr(te.tail, 13)
                else cdo.snowflake
              end,
              'name', ti.name,
              'handle', tu.handle,
              'roomId', case when te.tail not like 'did:discord:%' then te.tail else null end
            ))
            from edges te
            left join comp_info ti on ti.entity = te.tail
            left join comp_user tu on tu.did = te.tail
            left join comp_discord_origin cdo on cdo.entity = te.tail
            where te.head = orig.id and te.label = 'tag'
          )
        ) as json, c.timestamp as canonical_timestamp, fwd.id as msg_id
        from entities fwd -- forward reference entity
          join edges fwd_edge on fwd_edge.head = fwd.id and fwd_edge.label = 'forward' -- forward edge
          join entities orig on orig.id = fwd_edge.tail -- original message
          join comp_content c on c.entity = orig.id -- original message content
          join edges author_edge on author_edge.head = orig.id and author_edge.label = 'author' -- original author (already resolved by materializer)
          left join comp_user u on u.did = author_edge.tail
          left join comp_info i on i.entity = author_edge.tail
        where
          fwd.room = ${page.params.object}
          and
          c.timestamp is not null -- Filter out messages without timestamps

      order by canonical_timestamp desc, msg_id desc
    `,
    (row) => {
      return JSON.parse(row.json);
    },
    { cache: true, description: "Messages query", origin: "ChatArea.svelte" },
  );

  let showLastN = $state(50);
  onNavigate(() => {
    showLastN = 50;
  });
  let isAtBottom = $state(true);
  let showJumpToPresent = $derived(!isAtBottom);

  let timeline = $derived(
    mapAsyncState(query.current, (results) => {
      if (!results) return [];

      // Results come in descending order (newest first), reverse to get chronological
      const reversed = results.toReversed();

      console.log(
        `[mergeDebug] === Processing ${reversed.length} messages ===`,
      );

      const mapped = reversed.map((message, index) => {
        // Get the previous message from the reversed array (if it exists)
        const prevMessage = index > 0 ? reversed[index - 1] : null;

        // Calculate mergeWithPrevious
        // Merge if same author AND within 5 minutes AND both authors exist
        let mergeWithPrevious: boolean | null = false;
        if (
          prevMessage &&
          message.authorDid &&
          prevMessage.authorDid === message.authorDid &&
          message.timestamp - prevMessage.timestamp < 1000 * 60 * 5
        ) {
          mergeWithPrevious = true;
        }

        // Debug logging
        const timeDiff = message.timestamp - (prevMessage?.timestamp || 0);
        const authorMatch = prevMessage?.authorDid === message.authorDid;

        // Only log first few, last few, and suspicious ones
        if (
          index < 5 ||
          index >= reversed.length - 2 ||
          timeDiff < 0 ||
          timeDiff > 1000 * 60 * 10
        ) {
          console.log(
            `[mergeDebug] ${index.toString().padStart(2, " ")}: ${message.id.substring(0, 8)}... author=${(message.authorDid || "null").substring(0, 15)}... merge=${mergeWithPrevious} | prevMatch=${authorMatch} timeDiff=${timeDiff}ms (${(timeDiff / 1000 / 60).toFixed(1)}min)`,
            {
              message,
              prevMessage: prevMessage
                ? {
                    id: prevMessage.id,
                    authorDid: prevMessage.authorDid,
                    timestamp: prevMessage.timestamp,
                    isBridged: prevMessage.isBridged,
                  }
                : null,
            },
          );
        }

        return {
          ...message,
          mergeWithPrevious,
        };
      });

      return mapped;
    }),
  );

  // Messages to display - ensures the Virtualizer gets proper reactivity when data changes
  // This is computed as a derived state rather than a {@const} in the template to ensure
  // the Virtualizer is properly notified of data changes
  let displayMessages = $derived(
    mapAsyncState(timeline, (t) => t.slice(-showLastN)),
  );

  let viewport: HTMLDivElement = $state(null!);

  // Track initial load for auto-scroll
  let hasInitiallyScrolled = $state(false);
  // Track timeline length to detect new messages
  let prevTimelineLength = $state(0);

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
    if (!virtualizer || displayMessages.status !== "success") return;
    virtualizer.scrollToIndex(displayMessages.data.length - 1, {
      align: "start",
    });
    isAtBottom = true;
  }

  function handleScroll() {
    if (!viewport || !virtualizer) return;
    const { scrollTop, scrollHeight, clientHeight } = viewport;
    const isNearBottom = scrollHeight - (scrollTop + clientHeight) < 500;
    isAtBottom = isNearBottom;
  }

  function scrollToMessage(id: string) {
    if (displayMessages.status !== "success") return;
    const message = displayMessages.data.find((msg) => id === msg.id);
    if (!message) {
      toast.error("Message not found");
      return;
    }
    const idx = displayMessages.data.indexOf(message);
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
    if (
      !hasInitiallyScrolled &&
      displayMessages.status === "success" &&
      displayMessages.data.length > 0 &&
      virtualizer
    ) {
      setTimeout(() => {
        scrollToBottom();
        hasInitiallyScrolled = true;
      }, 200);
    }
    chatArea.scrollToMessage = scrollToMessage;
  });

  // Auto-scroll to bottom when new messages arrive and user is already at bottom
  $effect(() => {
    if (displayMessages.status !== "success") return;
    const len = displayMessages.data.length;
    if (len > prevTimelineLength && prevTimelineLength > 0 && isAtBottom) {
      scrollToBottom();
    }
    prevTimelineLength = len;
  });

  // Track which room we've loaded for to prevent re-triggering
  let lastLoadedRoomId: string | undefined;

  // Initial lazy load on room change
  $effect(() => {
    const spaceId = app.joinedSpace?.id;
    const roomId = app.roomId;

    if (!spaceId || !roomId) return;

    // Only trigger load if room actually changed
    if (roomId === lastLoadedRoomId) return;
    lastLoadedRoomId = roomId;

    // Reset state for new room
    lazyLoadState = { status: "idle" };
  });

  // Trigger lazy load when materialized data can't fill the current window.
  // When the query returns fewer rows than showLastN, we've exhausted what's
  // in SQLite and need the backend to materialize more events from the stream.
  $effect(() => {
    if (
      timeline.status === "success" &&
      timeline.data.length < showLastN &&
      hasMoreHistory &&
      !isLazyLoading
    ) {
      loadMoreMessages();
    }
  });
</script>

<div class="grow min-h-0 relative">
  <div class="absolute w-full bottom-4 right-2 z-50 flex justify-center">
    {#if showJumpToPresent}
      <Button onclick={scrollToBottom}>
        <IconArrowDown class="w-4 h-4" />
        Jump to present
      </Button>
    {/if}
  </div>

  {#snippet messagesSkeleton()}
    <div class="flex flex-col justify-end w-full h-full bg-transparent">
      <ChatMessageSkeleton />
      <ChatMessageSkeleton lines={3} />
      <ChatMessageSkeleton lines={1} />
      <ChatMessageSkeleton />
      <ChatMessageSkeleton mergeWithPrevious />
    </div>
  {/snippet}

  <ScrollArea.Root type="auto" class="h-full overflow-hidden">
    <ScrollArea.Viewport
      bind:ref={viewport}
      class="relative max-w-full w-full h-full"
      onscroll={handleScroll}
    >
      <div class="flex flex-col w-full h-full pb-16 pt-2">
        <StateSuspense state={displayMessages} pending={messagesSkeleton}>
          {#snippet children(messages)}
            <ol class="flex flex-col justify-end gap-2 max-w-full h-full">
              <StateSuspense state={lazyLoadState}>
                {#snippet children()}
                  {#if messages.length === 0}
                    <p class="opacity-80 p-4 text-center text-sm">
                      No messages here yet. This is the beginning of something
                      beautiful.
                    </p>
                  {/if}
                {/snippet}
                {#snippet pending()}
                  <div class="flex justify-center py-2">
                    <IconLoading class="animate-spin text-base-500" />
                  </div>
                {/snippet}
                {#snippet error({ message })}
                  <div
                    class="flex justify-center items-center gap-2 py-2 text-sm text-red-500"
                  >
                    <span>Failed to load older messages: {message}</span>
                    <Button
                      size="sm"
                      variant="secondary"
                      onclick={loadMoreMessages}>Retry</Button
                    >
                  </div>
                {/snippet}
              </StateSuspense>

              {#if messages.length > 0}
                <!--
                  The Virtualizer needs a stable scrollRef to function correctly.
                  We guard its creation until viewport is available to prevent virtua from
                  trying to access parentElement on a null containerRef.
                -->
                {#if viewport}
                  <Virtualizer
                    bind:this={virtualizer}
                    data={messages}
                    scrollRef={viewport}
                    overscan={5}
                    shift={true}
                    getKey={(x) => {
                      return x.id;
                    }}
                    onscroll={(o) => {
                      if (o < 100 && messages.length >= showLastN) {
                        showLastN += 50;
                      }
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
              {/if}
            </ol>
          {/snippet}
          {#snippet error(e)}
            <ErrorModal
              message={"Failed to get chat messages: " + e.message}
              goHome
            />
          {/snippet}
        </StateSuspense>
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
