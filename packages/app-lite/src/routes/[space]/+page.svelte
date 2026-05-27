<script lang="ts">
  import { page } from "$app/state";
  import { setNavbar } from "$lib/components/layout/navbar.svelte";
  import { createSpaceThreadsQuery } from "$lib/queries/threads";
  import BoardViewShell from "@roomy/design/components/content/thread/boardView/BoardView.svelte";
  import type { ThreadInfo } from "@roomy/design/components/content/thread/boardView/types.ts";

  const spaceId = $derived(page.params.space!);
  const threadsQuery = createSpaceThreadsQuery(() => spaceId);

  $effect(() => {
    setNavbar(indexNavbar);
    return () => setNavbar(undefined);
  });

  type RawThread = {
    id: string;
    name?: string;
    channel?: string;
    activity: {
      latestTimestamp?: string;
      latestMembers: Array<{ did: string; name?: string; avatar?: string }>;
    };
  };

  // Map SDK SpaceThread → design ThreadInfo
  let threads = $derived<ThreadInfo[]>(
    ((threadsQuery.data?.threads ?? []) as RawThread[]).map(mapThread),
  );

  function mapThread(t: RawThread): ThreadInfo {
    return {
      id: t.id,
      name: t.name ?? t.id.slice(0, 12) + "…",
      kind: "space.roomy.thread",
      channel: t.channel,
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
    if (thread.channel) {
      return `/${spaceId}/${thread.channel}`;
    }
    return `/${spaceId}/${thread.id}`;
  }
</script>

{#snippet indexNavbar()}
  <div class="flex-1 text-center font-bold text-lg text-base-900 dark:text-base-100">
    Index
  </div>
{/snippet}

<div class="h-full">
  {#if threadsQuery.isPending}
    <div class="h-full w-full flex items-center justify-center">
      <div class="text-sm text-base-400 p-2">Loading threads…</div>
    </div>
  {:else if threadsQuery.isError}
    <div class="h-full w-full flex items-center justify-center">
      <div class="text-sm text-red-600 p-2">{threadsQuery.error.message}</div>
    </div>
  {:else}
    <BoardViewShell {threads} emptyMessage="No threads in this space yet." {hrefFor} />
  {/if}
</div>
