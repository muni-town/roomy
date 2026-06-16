<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { setNavbar } from "$lib/components/layout/navbar.svelte";
  import ToggleTabs from "@roomy/design/components/layout/ToggleTabs.svelte";
  import ActivityFeed from "$lib/components/feed/ActivityFeed.svelte";
  import { createSpaceThreadsQuery } from "$lib/queries/threads";
  import BoardViewShell from "@roomy/design/components/content/thread/boardView/BoardView.svelte";
  import type { ThreadInfo } from "@roomy/design/components/content/thread/boardView/types.ts";

  const spaceId = $derived(page.params.space!);

  let activeTab = $state("Feed");

  const threadsQuery = createSpaceThreadsQuery(() => spaceId);

  type RawThread = {
    id: string;
    name?: string;
    canonicalParent?: string;
    unreadCount?: number;
    activity: {
      latestTimestamp?: string;
      latestMembers: Array<{ did: string; name?: string; avatar?: string }>;
      latestMessage?: {
        id: string;
        content: string;
        author: { did: string; name?: string; avatar?: string };
        timestamp?: string;
      };
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
      canonicalParent: t.canonicalParent,
      unreadCount: t.unreadCount ?? 0,
      activity: {
        members: t.activity.latestMembers.map((m) => ({
          id: m.did,
          name: m.name ?? null,
          avatar: m.avatar ?? null,
        })),
        latestTimestamp: t.activity.latestTimestamp
          ? new Date(t.activity.latestTimestamp).getTime()
          : 0,
        latestMessage: t.activity.latestMessage
          ? {
              id: t.activity.latestMessage.id,
              content: t.activity.latestMessage.content,
              author: {
                did: t.activity.latestMessage.author.did,
                name: t.activity.latestMessage.author.name,
                avatar: t.activity.latestMessage.author.avatar,
              },
              timestamp: t.activity.latestMessage.timestamp,
            }
          : null,
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
    <span class="grow"></span>
    <ToggleTabs
      items={[
        { name: "Feed", href: "#feed" },
        { name: "Threads", href: "#threads" },
      ]}
      bind:active={activeTab}
    />
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
      <div class="h-full w-full flex items-center justify-center">
        <div class="text-sm text-red-600 p-2">{threadsQuery.error.message}</div>
      </div>
    {:else}
      <BoardViewShell {threads} emptyMessage="No threads yet" {hrefFor} onAvatarClick={(did) => goto(`/user/${did}`)} />
    {/if}
  {/if}
</main>
