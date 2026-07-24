<script lang="ts">
  import { page } from "$app/state";
  import { createRoomThreadsQuery, type RoomThread } from "$lib/queries/threads";
  import BoardViewShell from "@roomy/design/components/content/thread/boardView/BoardView.svelte";
  import type { ThreadInfo } from "@roomy/design/components/content/thread/boardView/types.ts";
  import { resolveBlobUrl } from "$lib/utils";

  let {
    emptyMessage = "No threads yet",
  }: {
    emptyMessage?: string;
  } = $props();

  const roomId = $derived(page.params.room!);
  const threadsQuery = createRoomThreadsQuery(() => roomId);

  // Flatten all pages into a single array.
  let threads = $derived<ThreadInfo[]>(
    (threadsQuery.data?.pages.flatMap((p) => p.threads) ?? []).map(mapThread),
  );

  let hasMore = $derived(threadsQuery.hasNextPage ?? false);

  function loadMore() {
    threadsQuery.fetchNextPage();
  }

  function mapThread(t: RoomThread): ThreadInfo {
    return {
      id: t.id,
      name: t.name ?? "Unnamed Thread",
      kind: "space.roomy.thread",
      canonicalParent: t.canonicalParent,
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
    return `/${page.params.space}/${thread.id}${parentParam}`;
  }
</script>

{#if threadsQuery.isPending && !threadsQuery.data}
  <div class="h-full w-full flex items-center justify-center">
    <div class="text-sm text-base-400 p-2">Loading threads…</div>
  </div>
{:else if threadsQuery.isError && !threadsQuery.data}
  <div class="h-full w-full flex items-center justify-center">
    <div class="text-sm text-red-600 p-2">{threadsQuery.error.message}</div>
  </div>
{:else}
  <BoardViewShell {threads} {emptyMessage} {hrefFor} hideChannel {loadMore} {hasMore} />
{/if}
