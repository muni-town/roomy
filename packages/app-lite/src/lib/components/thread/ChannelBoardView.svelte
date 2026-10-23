<script lang="ts">
  /**
   * One channel's threads, as a board.
   *
   * A data adapter over the design board: it runs the query, maps the wire
   * threads to `ThreadInfo`, and builds each row's href. The board itself is
   * `@roomy/design`'s.
   */
  import BoardView from "@roomy/design/components/content/thread/boardView/BoardView.svelte";
  import type { ThreadInfo } from "@roomy/design/components/content/thread/boardView/types.ts";
  import { createRoomThreadsQuery, type RoomThread } from "$lib/queries/threads";
  import { resolveBlobUrl } from "@roomy/design/utils";

  let {
    roomId,
    spaceId,
    emptyMessage = "No threads yet",
  }: {
    roomId: string;
    /** The space the channel belongs to; thread links are rooted at it. */
    spaceId: string;
    emptyMessage?: string;
  } = $props();

  const threadsQuery = createRoomThreadsQuery(() => roomId);

  // Flatten all pages into a single array.
  const threads = $derived<ThreadInfo[]>(
    (threadsQuery.data?.pages.flatMap((p) => p.threads) ?? []).map(mapThread),
  );

  const hasMore = $derived(threadsQuery.hasNextPage ?? false);

  function loadMore() {
    threadsQuery.fetchNextPage();
  }

  function mapThread(t: RoomThread): ThreadInfo {
    return {
      id: t.id,
      name: t.name ?? "Unnamed Thread",
      kind: "space.roomy.thread",
      canonicalParent: t.canonicalParent,
      // Honest unread: the server marks threads with messages the user
      // hasn't read, including threads they've never engaged with.
      unread: t.unread ?? (t.unreadCount ?? 0) > 0,
      // 3-state: the dot marks threads the user has ENGAGED with and not
      // finished reading. The server only bumps unreadCount for engaged
      // users, so count > 0 implies engagement — a never-engaged thread
      // with messages is bold (unread) but dotless.
      unreadDot: (t.unreadCount ?? 0) > 0,
      activity: {
        members: t.activity.latestMembers.map((m) => ({
          id: m.did,
          name: m.name ?? null,
          avatar: resolveBlobUrl(m.avatar ?? undefined) ?? null,
        })),
        latestTimestamp: t.activity.latestTimestamp
          ? new Date(t.activity.latestTimestamp).getTime()
          : 0,
      },
    };
  }

  function hrefFor(thread: ThreadInfo): string {
    const parentParam = thread.canonicalParent
      ? "?parent=" + thread.canonicalParent
      : "";
    return `/${spaceId}/${thread.id}${parentParam}`;
  }
</script>

<div class="flex flex-col h-full min-h-0">
  <div class="flex-1 min-h-0">
    <BoardView
      {threads}
      {emptyMessage}
      {hrefFor}
      hideChannel
      {loadMore}
      {hasMore}
      loading={threadsQuery.isPending && !threadsQuery.data}
      loadingMessage="Loading threads…"
      error={threadsQuery.isLoadingError ? threadsQuery.error.message : undefined}
    />
  </div>
</div>
