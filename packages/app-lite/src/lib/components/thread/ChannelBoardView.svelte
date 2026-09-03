<script lang="ts">
  import { page } from "$app/state";
  import { createRoomThreadsQuery, type RoomThread } from "$lib/queries/threads";
  import BoardViewShell from "@roomy/design/components/content/thread/boardView/BoardView.svelte";
  import type { ThreadInfo } from "@roomy/design/components/content/thread/boardView/types.ts";
  import { IconSearch } from "@roomy/design/icons";
  import { resolveBlobUrl } from "$lib/utils";

  let {
    emptyMessage = "No threads yet",
  }: {
    emptyMessage?: string;
  } = $props();

  const roomId = $derived(page.params.room!);

  // Debounced search input: filters threads by name server-side (SQLite LIKE
  // on the thread name). 200ms matches the mention typeahead debounce.
  // NOTE: the input value must be read synchronously inside the effect —
  // Svelte 5 effects only track reads that happen during the effect run, so
  // reading it inside the setTimeout callback would never re-trigger.
  let searchInput = $state("");
  let searchTerm = $state("");
  $effect(() => {
    const value = searchInput;
    const timer = setTimeout(() => {
      searchTerm = value.trim();
    }, 200);
    return () => clearTimeout(timer);
  });

  const threadsQuery = createRoomThreadsQuery(() => roomId, () => searchTerm);

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
  <div class="flex flex-col h-full min-h-0">
    <div class="shrink-0 px-3 pt-2">
      <div class="relative">
        <IconSearch class="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-base-400" />
        <input
          type="text"
          bind:value={searchInput}
          placeholder="Search threads…"
          class="w-full ring-1 ring-inset ring-base-300 dark:ring-base-700 focus:ring-2 focus:ring-accent-500 bg-base-100 dark:bg-base-800/50 focus:bg-accent-400/5 dark:focus:bg-accent-600/5 text-base-900 dark:text-base-100 placeholder:text-base-400 dark:placeholder:text-base-500 rounded-2xl pl-9 pr-3 py-1.5 text-sm font-medium outline-none border-0 transition-colors"
        />
      </div>
    </div>
    <div class="flex-1 min-h-0">
      <BoardViewShell {threads} {emptyMessage} {hrefFor} hideChannel {loadMore} {hasMore} />
    </div>
  </div>
{/if}
