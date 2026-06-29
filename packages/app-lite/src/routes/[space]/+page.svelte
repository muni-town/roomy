<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { page } from "$app/state";
  import { setNavbar } from "$lib/components/layout/navbar.svelte";
  import { spaceNavigation } from "$lib/components/layout/last-room.svelte";
  import ToggleTabs from "@roomy/design/components/layout/ToggleTabs.svelte";
  import ActivityFeed from "$lib/components/feed/ActivityFeed.svelte";
  import { createSpaceThreadsQuery } from "$lib/queries/threads";
  import BoardViewShell from "@roomy/design/components/content/thread/boardView/BoardView.svelte";
  import type { ThreadInfo } from "@roomy/design/components/content/thread/boardView/types.ts";
  import ErrorMessage from "@roomy/design/components/helper/ErrorMessage.svelte";

  const spaceId = $derived(page.params.space!);

  let activeTab = $state(
    spaceNavigation.get(spaceId)?.viewMode === "threads" ? "Threads" : "Feed",
  );

  // Re-sync from stored state when spaceId changes (component reuse across
  // spaces — SvelteKit reuses the same page component for the same route
  // pattern, so $state() only initializes once).
  $effect(() => {
    const sid = spaceId;
    untrack(() => {
      const stored = spaceNavigation.get(sid)?.viewMode;
      activeTab = stored === "threads" ? "Threads" : "Feed";
    });
  });

  // Sync tab state from URL hash — clicking a toggle tab navigates to the hash,
  // which gives the user working browser back/forward between views.
  // Only reacts when a hash is present; on initial load with no hash the
  // stored state (or default "Feed") is preserved.
  $effect(() => {
    if (page.url.hash === "#feed") {
      activeTab = "Feed";
    } else if (page.url.hash === "#threads") {
      activeTab = "Threads";
    }
  });

  // Persist the active tab and destination together so the server bar and
  // channel page can restore both when switching spaces.
  $effect(() => {
    spaceNavigation.set(spaceId, {
      destination: { kind: "index" },
      viewMode: activeTab === "Threads" ? "threads" : "chat",
    });
  });

  const threadsQuery = createSpaceThreadsQuery(() => spaceId);

  type RawThread = {
    id: string;
    name?: string;
    channelName?: string;
    canonicalParent?: string;
    unreadCount?: number;
    activity: {
      latestTimestamp?: string;
      latestMembers: Array<{ did: string; name?: string; avatar?: string }>;
    };
  };

  let threads = $derived<ThreadInfo[]>(
    ((threadsQuery.data?.threads ?? []) as RawThread[]).map(mapThread),
  );

  function mapThread(t: RawThread): ThreadInfo {
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

  onMount(() => {
    setNavbar(spaceNavbar);
    return () => setNavbar(undefined);
  });
</script>

{#snippet spaceNavbar()}
  <div class="flex items-center gap-2 px-2 min-w-0 grow">
    <span class="grow sm:hidden"></span>
    <div
      class="sm:absolute sm:left-1/2 sm:top-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2"
    >
      <ToggleTabs
        items={[
          { name: "Feed", href: "#feed" },
          { name: "Threads", href: "#threads" },
        ]}
        active={activeTab}
      />
    </div>
  </div>
{/snippet}

<main class="h-full overflow-y-auto">
  {#if activeTab === "Feed"}
    <ActivityFeed {spaceId} limit={50} showSpaceInfo={false} />
  {:else}
    {#if threadsQuery.isPending}
      <div class="h-full w-full flex items-center justify-center">
        <div class="text-sm text-base-400 p-2">Loading threads…</div>
      </div>
    {:else if threadsQuery.isError}
      <ErrorMessage message={threadsQuery.error.message} class="h-full w-full justify-center" />
    {:else}
      <BoardViewShell {threads} emptyMessage="No threads yet" {hrefFor} />
    {/if}
  {/if}
</main>
