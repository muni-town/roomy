<script lang="ts">
  import { page } from "$app/state";
  import { createSpaceThreadsQuery } from "$lib/queries/threads";
  import BoardViewShell from "@roomy/design/components/content/thread/boardView/BoardView.svelte";
  import type { ThreadInfo } from "@roomy/design/components/content/thread/boardView/types.ts";
  import ErrorMessage from "@roomy/design/components/helper/ErrorMessage.svelte";
  import { resolveBlobUrl } from "$lib/utils";

  let { spaceId }: { spaceId: string } = $props();

  const threadsQuery = createSpaceThreadsQuery(() => spaceId);

  // Flatten all pages into a single array.
  let threads = $derived<ThreadInfo[]>(
    (threadsQuery.data?.pages.flatMap((p) => p.threads) ?? []).map(mapThread),
  );

  let hasMore = $derived(threadsQuery.hasNextPage ?? false);

  function loadMore() {
    threadsQuery.fetchNextPage();
  }

  function mapThread(t: {
    id: string;
    name?: string;
    channelName?: string;
    canonicalParent?: string;
    unreadCount?: number;
    activity: {
      latestTimestamp?: string;
      latestMembers: Array<{ did: string; name?: string | null; avatar?: string | null }>;
    };
  }): ThreadInfo {
    return {
      id: t.id,
      name: t.name ?? "Unnamed Thread",
      kind: "space.roomy.thread",
      channelName: t.channelName,
      canonicalParent: t.canonicalParent,
      unread: (t.unreadCount ?? 0) > 0,
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
  <ErrorMessage message={threadsQuery.error.message} class="h-full w-full justify-center" />
{:else}
  <BoardViewShell {threads} emptyMessage="No threads yet" {hrefFor} {loadMore} {hasMore} />
{/if}
