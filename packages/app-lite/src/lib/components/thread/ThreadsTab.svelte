<script lang="ts">
  /**
   * The space index's board: every channel and thread in the space, ordered by
   * latest activity.
   *
   * A data adapter over the design board: it runs the query, maps the wire
   * rooms to `ThreadInfo`, and builds each row's href. The board itself —
   * list, first-load state, error state, empty state, pagination — is
   * `@roomy/design`'s.
   */
  import BoardView from "@roomy/design/components/content/thread/boardView/BoardView.svelte";
  import type { ThreadInfo } from "@roomy/design/components/content/thread/boardView/types.ts";
  import { createSpaceThreadsQuery, type SpaceRoom } from "$lib/queries/threads";
  import { resolveBlobUrl } from "@roomy/design/utils";

  let { spaceId }: { spaceId: string } = $props();

  const roomsQuery = createSpaceThreadsQuery(() => spaceId);

  // Flatten all pages into a single array. The space index board shows
  // channels AND threads, ordered by latest activity.
  const rooms = $derived<ThreadInfo[]>(
    (roomsQuery.data?.pages.flatMap((p) => p.rooms) ?? []).map(mapRoom),
  );

  const hasMore = $derived(roomsQuery.hasNextPage ?? false);

  function loadMore() {
    roomsQuery.fetchNextPage();
  }

  function mapRoom(r: SpaceRoom): ThreadInfo {
    return {
      id: r.id,
      name: r.name ?? "Unnamed Thread",
      kind: r.kind === "channel" ? "space.roomy.channel" : "space.roomy.thread",
      // Channels have no parent channel; show their own name in the right
      // column too so the board reads consistently (duplicated — intended).
      channelName: r.channelName ?? (r.kind === "channel" ? r.name : undefined),
      // Honest unread: the server marks a room unread when it has messages
      // the user hasn't read (threads this user never engaged with count
      // as unread; channels follow the sidebar's unreadCount).
      unread: r.unread ?? (r.unreadCount ?? 0) > 0,
      // 3-state: the dot marks rooms the user has ENGAGED with and not
      // finished reading. For threads, the server only bumps unreadCount
      // for engaged users, so count > 0 implies engagement — a
      // never-engaged thread with messages is bold but dotless. Channels
      // always get the dot when unread (their count is the sidebar's).
      unreadDot: (r.unreadCount ?? 0) > 0,
      activity: {
        members: r.activity.latestMembers.map((m) => ({
          id: m.did,
          name: m.name ?? null,
          avatar: resolveBlobUrl(m.avatar ?? undefined) ?? null,
        })),
        latestTimestamp: r.activity.latestTimestamp
          ? new Date(r.activity.latestTimestamp).getTime()
          : 0,
        ...(r.activity.latestMessage
          ? {
              latestMessage: {
                id: r.activity.latestMessage.id,
                text: r.activity.latestMessage.content,
              },
            }
          : {}),
      },
    };
  }

  function hrefFor(room: ThreadInfo): string {
    const parentParam = room.canonicalParent
      ? "?parent=" + room.canonicalParent
      : "";
    return `/${spaceId}/${room.id}${parentParam}`;
  }
</script>

<div class="flex flex-col h-full min-h-0">
  <div class="flex-1 min-h-0">
    <BoardView
      threads={rooms}
      emptyMessage="No activity yet"
      {hrefFor}
      {loadMore}
      {hasMore}
      loading={roomsQuery.isPending && !roomsQuery.data}
      error={roomsQuery.isLoadingError ? roomsQuery.error.message : undefined}
    />
  </div>
</div>
