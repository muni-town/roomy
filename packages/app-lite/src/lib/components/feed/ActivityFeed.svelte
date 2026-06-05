<script lang="ts">
  import { createActivityFeedQuery, type ActivityItem } from "$lib/queries/activity-feed";
  import { resolveBlobUrl } from "$lib/utils";
  import { renderMarkdownSanitized } from "@roomy/design/utils";
  import SpaceAvatar from "@roomy/design/components/spaces/SpaceAvatar.svelte";

  let { spaceId, limit = 20 }: { spaceId?: string; limit?: number } = $props();

  const feedQuery = createActivityFeedQuery(() => ({ spaceId, limit }));

  function timeAgo(iso: string): string {
    const ms = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(ms / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(iso).toLocaleDateString();
  }

  function roomHref(item: ActivityItem): string {
    return `/${item.spaceId}/${item.threadId}`;
  }

  function avatarUrl(item: ActivityItem): string | undefined {
    return resolveBlobUrl(item.spaceAvatar);
  }
</script>

{#if feedQuery.isPending}
  <div class="flex justify-center py-8">
    <p class="text-sm text-base-400">Loading activity feed…</p>
  </div>
{:else if feedQuery.isError}
  <div class="flex justify-center py-8">
    <p class="text-sm text-red-600">Error: {feedQuery.error.message}</p>
  </div>
{:else if feedQuery.data}
  {@const feed = feedQuery.data.feed}

  {#if feed.length === 0}
    <div class="flex justify-center py-8">
      <p class="text-sm text-base-400">No recent activity.</p>
    </div>
  {:else}
    <div class="flex flex-col gap-3 w-full">
      {#each feed as item (item.threadId)}
        <a
          href={roomHref(item)}
          class="flex flex-col gap-2 rounded-lg border border-base-200 dark:border-base-800 bg-white dark:bg-base-900 p-4 hover:border-base-300 dark:hover:border-base-700 transition-colors no-underline"
        >
          <!-- Header: space avatar + space/channel context -->
          <div class="flex items-center gap-2 text-xs text-base-500">
            {#if item.spaceAvatar || item.spaceName}
              <SpaceAvatar
                src={resolveBlobUrl(item.spaceAvatar)}
                id={item.spaceId}
                name={item.spaceName ?? undefined}
                size={30}
              />
            {/if}
            {#if item.spaceName}
              <span class="font-medium">{item.spaceName}</span>
            {/if}
            {#if item.channelName}
              <span>in #{item.channelName}</span>
            {/if}
            {#if item.threadName}
              <span class="truncate">{item.threadName}</span>
            {/if}
            {#if item.unreadCount > 0}
              <span
                class="inline-flex items-center rounded-full bg-accent-400 dark:bg-accent-600 px-2 py-0.5 text-xs font-semibold text-white"
              >
                {item.unreadCount} unread
              </span>
            {/if}
            <span class="ml-auto shrink-0">{timeAgo(item.lastActivityAt)}</span>
          </div>

          <!-- Recent messages -->
          <div class="flex flex-col gap-1.5 pl-1 mt-1">
            {#each item.messages as msg (msg.id)}
              <div class="flex items-start gap-2 text-sm">
                <div class="mt-0.75"><SpaceAvatar
                  src={resolveBlobUrl(msg.author.avatar)}
                  id={msg.author.did}
                  name={msg.author.name ?? undefined}
                  size={18}
                /></div>
                <div class="min-w-0">
                  <span class="font-medium text-base-700 dark:text-base-300">
                    {msg.author.name ?? msg.author.did.slice(0, 8)}
                  </span>
                  <span class="text-base-600 dark:text-base-400 [&_p]:inline [&_p]:m-0">
                    {@html renderMarkdownSanitized(msg.content)}
                  </span>
                </div>
              </div>
            {/each}
          </div>
        </a>
      {/each}
    </div>
  {/if}
{/if}
