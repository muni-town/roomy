<script lang="ts">
  import { page } from "$app/state";
  import { useTopicSubscription } from "@roomy-space/sdk/svelte";
  import type { Topic } from "@roomy-space/sdk/svelte";
  import { schemas } from "@roomy-space/sdk";
  import { auth } from "$lib/auth.svelte";
  import { sync_ } from "$lib/sync.svelte";
  import { createSpaceMetadataQuery } from "$lib/queries/space-metadata";

  type SidebarChannel = typeof schemas.queries.getSpaceMetadata.SidebarChannel.infer;

  let { children } = $props();

  const spaceId = $derived(page.params.space!);

  useTopicSubscription(
    () => sync_.ctx?.topicManager ?? null,
    () => [{ kind: "space", id: spaceId } satisfies Topic],
  );
</script>

{#if !auth.authenticated}
  <div class="p-4 text-sm text-base-500">Not authenticated.</div>
{:else}
  <div class="min-h-screen flex bg-base-50 dark:bg-base-950 text-base-800 dark:text-base-200">
    {@render sidebar()}
    <main class="flex-1 overflow-hidden">
      {@render children()}
    </main>
  </div>
{/if}

{#snippet sidebar()}
  {@const metaQuery = createSpaceMetadataQuery(() => spaceId)}
  <aside class="w-64 shrink-0 border-r border-base-200 dark:border-base-800 bg-white dark:bg-base-900 flex flex-col">
    <div class="px-3 py-2 border-b border-base-200 dark:border-base-800 flex items-center gap-2">
      <a href="/" class="text-xs text-base-500 hover:text-base-700 dark:hover:text-base-300">← Spaces</a>
    </div>

    {#if metaQuery.isPending}
      <p class="p-3 text-sm text-base-400">Loading sidebar…</p>
    {:else if metaQuery.isError}
      <p class="p-3 text-sm text-red-600">{metaQuery.error.message}</p>
    {:else if metaQuery.data}
      {@const meta = metaQuery.data}
      <div class="px-3 py-2 border-b border-base-200 dark:border-base-800">
        <h2 class="font-semibold text-sm truncate">{meta.name || spaceId}</h2>
      </div>
      <div class="flex-1 overflow-y-auto">
        {#each meta.sidebar.categories as category}
          <div class="px-3 pt-2 pb-0.5 text-[11px] font-semibold uppercase tracking-wider text-base-400 dark:text-base-500">
            {category.name}
          </div>
          {#each category.channels as channel}
            {@render channelItem(channel)}
          {/each}
        {/each}
        {#each meta.sidebar.orphans as channel}
          {@render channelItem(channel)}
        {/each}
      </div>
    {/if}
  </aside>
{/snippet}

{#snippet channelItem(channel: SidebarChannel)}
  <a
    href={`/${spaceId}/${channel.id}`}
    class="w-full text-left px-4 py-1.5 hover:bg-base-100 dark:hover:bg-base-800 text-sm flex items-center justify-between {!channel.canRead ? 'opacity-50 pointer-events-none' : ''}"
  >
    <span class="truncate">
      {#if !channel.canWrite && channel.canRead}🔒 {/if}{channel.name}
    </span>
    {#if channel.unreadCount > 0}
      <span class="bg-accent-500 text-white text-[10px] px-1 py-0.5 rounded-full font-medium">
        {channel.unreadCount}
      </span>
    {/if}
  </a>
{/snippet}
