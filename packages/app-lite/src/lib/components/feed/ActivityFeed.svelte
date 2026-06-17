<script lang="ts">
  import { goto } from "$app/navigation";
  import { createActivityFeedQuery, type ActivityItem } from "$lib/queries/activity-feed";
  import { resolveBlobUrl } from "$lib/utils";
  import { renderMarkdownSanitized } from "@roomy/design/utils";
  import SpaceAvatar from "@roomy/design/components/spaces/SpaceAvatar.svelte";
  import ActivityFeedSkeleton from "./ActivityFeedSkeleton.svelte";
  import { slide } from "svelte/transition";

  let { spaceId, showSpaceInfo = true, limit = 20 }: { spaceId?: string; showSpaceInfo?: boolean; limit?: number } = $props();

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
  <ActivityFeedSkeleton count={limit > 10 ? 5 : 3} />
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
    <div class="flex flex-col w-full">
      {#each feed as item, i (item.threadId)}
        <a
          href={roomHref(item)}
          class="flex flex-col gap-2 p-4 transition-colors group no-underline hover:bg-base-100 dark:hover:bg-base-800/40 hover:shadow-[2px_2px_0_0_var(--color-base-300)] dark:hover:shadow-[2px_2px_0_0_var(--color-base-800)]"
        >
          <!-- Header: space avatar + space/channel context -->
          <div class="flex items-center gap-2 text-xs">
            {#if showSpaceInfo}
              {#if item.spaceAvatar || item.spaceName}
                <SpaceAvatar
                  src={resolveBlobUrl(item.spaceAvatar)}
                  id={item.spaceId}
                  name={item.spaceName ?? undefined}
                  size={30}
                />
              {/if}
              <!-- {#if item.spaceName}
                <span class="font-medium hidden group-hover:block text-lg">{item.spaceName}</span>
              {/if} -->
            {/if}
            {#if item.channelName || item.threadName}
              <span class={["truncate text-lg font-bold", item.channelName ? "opacity-70" : ""]}>#{item.channelName || item.threadName}</span>
            {/if}
            {#if item.threadName && item.channelName}
              <span class="truncate text-lg font-bold pl-1 -ml-1">/ {item.threadName}</span>
            {/if}

            {#if item.unreadCount > 0}
              <span
                class="inline-flex items-center rounded-full bg-accent-200 dark:bg-accent-600 px-2 py-0.5 text-xs font-semibold text-black/50 dark:text-white whitespace-nowrap"
              >
                {item.unreadCount} unread
              </span>
            {/if}
            <span class="ml-auto shrink-0 opacity-70">{timeAgo(item.lastActivityAt)}</span>
          </div>

          {#if item.messages.length > 0}
            {@const reversed = [...item.messages].reverse()}
            {@const preceding = reversed.slice(0, -1)}
            {@const last = reversed.at(-1)}

            <!-- Preceding context messages (capped height, oldest cut off at top) -->
            {#if preceding.length > 0}
              <div class="flex flex-col justify-end gap-1.5 pl-1 max-h-24 overflow-hidden [mask-image:linear-gradient(to_bottom,transparent_0%,black_20%)] [-webkit-mask-image:linear-gradient(to_bottom,transparent_0%,black_20%)]">
                {#each preceding as msg (msg.id)}
                  <div class="flex items-start gap-2 text-sm opacity-80">
                    <button
                      onclick={() => goto(`/user/${msg.author.did}`)}
                      class="mt-0.75 rounded-full hover:ring-2 hover:ring-accent-500 transition-all cursor-pointer shrink-0"
                    ><SpaceAvatar
                      src={resolveBlobUrl(msg.author.avatar)}
                      id={msg.author.did}
                      name={msg.author.name ?? undefined}
                      size={18}
                    /></button>
                    <div class="min-w-0">
                      <button
                        onclick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          goto(`/user/${msg.author.did}`);
                        }}
                        class="font-medium text-base-700 dark:text-base-300 hover:underline cursor-pointer bg-transparent border-none p-0 inline"
                      >
                        {msg.author.name ?? msg.author.did.slice(0, 8)}
                      </button>
                      <span class="text-base-600 dark:text-base-400 break-words [&_p]:inline [&_p]:m-0">
                        {@html renderMarkdownSanitized(msg.content)}
                      </span>
                    </div>
                  </div>
                {/each}
              </div>
            {/if}

            <!-- Most recent message (full height) -->
            <div class="flex items-start gap-2 text-sm pl-1">
              <button
                onclick={() => goto(`/user/${last.author.did}`)}
                class="mt-0.75 rounded-full hover:ring-2 hover:ring-accent-500 transition-all cursor-pointer shrink-0"
              ><SpaceAvatar
                src={resolveBlobUrl(last.author.avatar)}
                id={last.author.did}
                name={last.author.name ?? undefined}
                size={18}
              /></button>
              <div class="min-w-0">
                <button
                  onclick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    goto(`/user/${last.author.did}`);
                  }}
                  class="font-medium text-base-700 dark:text-base-300 hover:underline cursor-pointer bg-transparent border-none p-0 inline"
                >
                  {last.author.name ?? last.author.did.slice(0, 8)}
                </button>
                <span class="text-base-600 dark:text-base-400 break-words [&_p]:inline [&_p]:m-0">
                  {@html renderMarkdownSanitized(last.content)}
                </span>
              </div>
            </div>
          {/if}
        </a>
        {#if i < feed.length - 1}
          <hr class="border-base-200 dark:border-base-800" />
        {/if}
      {/each}
    </div>
  {/if}
{/if}
