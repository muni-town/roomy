<script lang="ts">
  import { page } from "$app/state";
  import { createRoomThreadsQuery } from "$lib/queries/threads";
  import BoardViewShell from "@roomy/design/components/content/thread/boardView/BoardView.svelte";
  import type { ThreadInfo } from "@roomy/design/components/content/thread/boardView/types.ts";

  let {
    emptyMessage = "No threads yet",
  }: {
    emptyMessage?: string;
  } = $props();

  const roomId = $derived(page.params.room!);
  const threadsQuery = createRoomThreadsQuery(() => roomId);

  type RawThread = {
    id: string;
    name?: string;
    canonicalParent?: string;
    activity: {
      latestTimestamp?: string;
      latestMembers: Array<{ did: string; name?: string; avatar?: string }>;
    };
  };

  // Map SDK RoomThread → design ThreadInfo
  let threads = $derived<ThreadInfo[]>(
    ((threadsQuery.data?.threads ?? []) as RawThread[]).map(mapThread),
  );

  function mapThread(t: RawThread): ThreadInfo {
    return {
      id: t.id,
      name: t.name ?? t.id.slice(0, 12) + "…",
      kind: "space.roomy.thread",
      canonicalParent: t.canonicalParent,
      activity: {
        members: t.activity.latestMembers.map((m) => ({
          id: m.did,
          name: m.name ?? null,
          avatar: m.avatar ?? null,
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

{#if threadsQuery.isPending}
  <div class="h-full w-full flex items-center justify-center">
    <div class="text-sm text-base-400 p-2">Loading threads…</div>
  </div>
{:else if threadsQuery.isError}
  <div class="h-full w-full flex items-center justify-center">
    <div class="text-sm text-red-600 p-2">{threadsQuery.error.message}</div>
  </div>
{:else}
  <BoardViewShell {threads} {emptyMessage} {hrefFor} />
{/if}
