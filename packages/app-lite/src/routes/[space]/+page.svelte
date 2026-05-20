<script lang="ts">
  import { page } from "$app/state";
  import { setNavbar } from "$lib/components/layout/navbar.svelte";
  import { createSpaceThreadsQuery, type SpaceThread } from "$lib/queries/threads";

  const spaceId = $derived(page.params.space!);
  const threadsQuery = createSpaceThreadsQuery(() => spaceId);

  $effect(() => {
    setNavbar(indexNavbar);
    return () => setNavbar(undefined);
  });

  function formatTime(iso: string | null) {
    if (!iso) return "";
    const d = new Date(iso);
    return d.toLocaleString("en", {
      hour12: false,
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
</script>

{#snippet indexNavbar()}
  <div class="flex-1 text-center font-bold text-lg text-base-900 dark:text-base-100">
    Index
  </div>
{/snippet}

<div class="h-full overflow-y-auto px-6 py-6">
  {#if threadsQuery.isPending}
    <p class="text-sm text-base-400">Loading threads…</p>
  {:else if threadsQuery.isError}
    <p class="text-sm text-red-600">{threadsQuery.error.message}</p>
  {:else if threadsQuery.data}
    {@const threads = threadsQuery.data.threads}
    {#if threads.length === 0}
      <p class="text-sm text-base-400">No threads in this space yet.</p>
    {:else}
      <ul class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {#each threads as thread (thread.id)}
          {@render threadCard(thread)}
        {/each}
      </ul>
    {/if}
  {/if}
</div>

{#snippet threadCard(thread: SpaceThread)}
  <li>
    <a
      href={thread.channel ? `/${spaceId}/${thread.channel}` : `/${spaceId}/${thread.id}`}
      class="block p-3 rounded-2xl border border-base-200 dark:border-base-800 bg-white dark:bg-base-900 hover:border-base-300 dark:hover:border-base-700"
    >
      <div class="flex items-start justify-between gap-2">
        <h3 class="font-medium text-sm truncate flex-1">{thread.name || thread.id.slice(0, 12) + "…"}</h3>
        {#if thread.activity.latestTimestamp}
          <span class="text-[11px] text-base-400 shrink-0">{formatTime(thread.activity.latestTimestamp)}</span>
        {/if}
      </div>
      {#if thread.activity.latestMembers.length > 0}
        <div class="flex -space-x-1 mt-2">
          {#each thread.activity.latestMembers.slice(0, 5) as member}
            <span
              class="w-6 h-6 rounded-full border-2 border-white dark:border-base-900 bg-base-200 dark:bg-base-700 flex items-center justify-center text-[10px] font-semibold text-base-500"
              title={member.name ?? member.did}
            >
              {(member.name ?? "?")[0]?.toUpperCase() ?? "?"}
            </span>
          {/each}
        </div>
      {/if}
    </a>
  </li>
{/snippet}
