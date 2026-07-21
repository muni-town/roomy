<script lang="ts">
  import { goto } from "$app/navigation";
  import { createActivityFeedQuery, type ActivityItem } from "$lib/queries/activity-feed";
  import { resolveBlobUrl } from "$lib/utils";
  import { renderMarkdownSanitized, formatRelativeTime } from "@roomy/design/utils";
  import SpaceAvatar from "@roomy/design/components/spaces/SpaceAvatar.svelte";
  import UserAvatar from "@roomy/design/components/user/UserAvatar.svelte";
  import ActivityFeedSkeleton from "./ActivityFeedSkeleton.svelte";
  import ErrorMessage from "@roomy/design/components/helper/ErrorMessage.svelte";
  import MediaEmbed from "../chat/embeds/MediaEmbed.svelte";
  import LinkCard from "../chat/embeds/LinkCard.svelte";
  import MessageReactions from "../chat/MessageReactions.svelte";
  import { auth } from "$lib/auth.svelte";
  import { IconChevronRight } from "@roomy/design/icons";

  let { spaceId, showSpaceInfo = true, limit = 20 }: { spaceId?: string; showSpaceInfo?: boolean; limit?: number } = $props();

  const feedQuery = createActivityFeedQuery(() => ({ spaceId, limit }));

  const currentUserDid = $derived(auth.userDid);

  function timeAgo(iso: string): string {
    return formatRelativeTime(new Date(iso));
  }
  function isBridged(did: string): boolean {
    return did.startsWith("did:discord:");
  }


  function roomHref(item: ActivityItem): string {
    return `/${item.spaceId}/${item.threadId}`;
  }
</script>

{#if feedQuery.isPending}
  <ActivityFeedSkeleton count={limit > 10 ? 5 : 3} />
{:else if feedQuery.isError}
  <ErrorMessage message={feedQuery.error.message} class="py-8 justify-center" />
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
          <div class="flex items-baseline gap-1 text-xs">
            {#if showSpaceInfo}
              {#if item.spaceAvatar || item.spaceName}
                <span class="self-center">
                  <SpaceAvatar
                    src={resolveBlobUrl(item.spaceAvatar)}
                    id={item.spaceId}
                    name={item.spaceName ?? undefined}
                    size={30}
                  />
                </span>
              {/if}
              <!-- {#if item.spaceName}
                <span class="font-medium hidden group-hover:block text-lg">{item.spaceName}</span>
              {/if} -->
            {/if}
            {#if item.channelName || item.threadName}
              <span class={["truncate text-sm font-medium", item.channelName ? "opacity-70" : ""]}>#{item.channelName || item.threadName}</span>
            {#if item.threadName && item.channelName}
              <span class="truncate text-sm font-medium flex items-center gap-1"><IconChevronRight class="size-2.5 shrink-0 opacity-70" /> {item.threadName}</span>
            {/if}
            {/if}

            <span class="shrink-0 opacity-50 ml-1">{timeAgo(item.lastActivityAt)}</span>

            {#if item.unreadCount > 0}
              <span
                class="inline-flex items-center rounded-full bg-accent-200 dark:bg-accent-600 px-2 py-0.5 text-xs font-semibold text-black/50 dark:text-white whitespace-nowrap self-center"
              >
                {item.unreadCount} unread
              </span>
            {/if}
          </div>

          {#if item.messages.length > 0}
            {@const reversed = [...item.messages].reverse()}
            {@const preceding = reversed.slice(0, -1).slice(-2)}
            {@const last = reversed.at(-1)}

            <!-- Preceding context messages (capped height, oldest cut off at top) -->
            {#if preceding.length > 0}
              <div class="flex flex-col justify-end gap-1.5 pl-1 max-h-24 overflow-hidden [mask-image:linear-gradient(to_bottom,transparent_0%,black_20%)] [-webkit-mask-image:linear-gradient(to_bottom,transparent_0%,black_20%)]">
                {#each preceding as msg (msg.id)}
                  <div class="flex items-start gap-2 text-sm opacity-80">
                    {#if isBridged(msg.author.did)}
                      <div class="mt-1.25 rounded-full shrink-0">
                        <SpaceAvatar
                          src={resolveBlobUrl(msg.author.avatar)}
                          id={msg.author.did}
                          name={msg.author.name ?? undefined}
                          size={18}
                        />
                      </div>
                    {:else}
                      <button
                        onclick={() => goto(`/user/${msg.author.did}`)}
                        class="mt-1.25 rounded-full hover:ring-2 hover:ring-accent-500 transition-all cursor-pointer shrink-0"
                      ><SpaceAvatar
                        src={resolveBlobUrl(msg.author.avatar)}
                        id={msg.author.did}
                        name={msg.author.name ?? undefined}
                        size={18}
                      /></button>
                    {/if}
                    <div class="min-w-0">
                      {#if isBridged(msg.author.did)}
                        <span
                          class="font-medium text-base-700 dark:text-base-300"
                        >
                          {msg.author.name || msg.author.handle}
                        </span>
                      {:else}
                        <button
                          onclick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            goto(`/user/${msg.author.did}`);
                          }}
                          class="font-medium text-base-700 dark:text-base-300 hover:underline cursor-pointer bg-transparent border-none p-0 inline"
                        >
                          {msg.author.name || msg.author.handle}
                        </button>
                      {/if}
                      <span class="prose dark:prose-invert prose-a:text-accent-600 dark:prose-a:text-accent-400 prose-a:no-underline text-base-600 dark:text-base-400 break-words [&_p]:inline [&_p]:m-0">
                        {@html renderMarkdownSanitized(msg.content)}
                      </span>
                    </div>
                  </div>
                {/each}
              </div>
            {/if}

            {#if last}
            <!-- Most recent message (full height, chat-style layout) -->
            <div class="flex items-start gap-3 pl-1">
              {#if isBridged(last.author.did)}
                <div class="mt-0.5 rounded-full shrink-0">
                  <UserAvatar
                    src={resolveBlobUrl(last.author.avatar)}
                    name={last.author.did}
                    class="size-8 sm:size-10"
                  />
                </div>
              {:else}
                <button
                  onclick={() => goto(`/user/${last.author.did}`)}
                  class="mt-0.5 rounded-full hover:ring-2 hover:ring-accent-500 transition-all cursor-pointer shrink-0"
                ><UserAvatar
                  src={resolveBlobUrl(last.author.avatar)}
                  name={last.author.did}
                  class="size-8 sm:size-10"
                /></button>
              {/if}
              <div class="flex flex-col flex-1 min-w-0">
                <div class="text-sm w-full text-start">
                  {#if isBridged(last.author.did)}
                    <span
                      class="font-medium text-accent-700 dark:text-accent-400"
                    >
                      {last.author.name || last.author.handle}
                    </span>
                  {:else}
                    <button
                      onclick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        goto(`/user/${last.author.did}`);
                      }}
                      class="font-medium text-accent-700 dark:text-accent-400 hover:underline cursor-pointer bg-transparent border-none p-0 inline"
                    >
                      {last.author.name || last.author.handle}
                    </button>
                  {/if}
                </div>
                <div class="prose dark:prose-invert prose-a:text-accent-600 dark:prose-a:text-accent-400 prose-a:no-underline text-base font-normal text-left max-w-full overflow-auto hide-scrollbar break-words [&_p]:m-0 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0">
                  {@html renderMarkdownSanitized(last.content)}
                </div>

                {#if last.media && last.media.length > 0}
                  {@const nonLinkMedia = last.media.filter((m) => !m.type.startsWith("text/"))}
                  {#if nonLinkMedia.length > 0}
                    <MediaEmbed media={nonLinkMedia.map((m) => ({ ...m, alt: m.alt ?? undefined }))} />
                  {/if}
                {/if}

                {#if last.linkEmbeds && last.linkEmbeds.length > 0}
                  <div class="flex flex-col gap-2 mt-1">
                    {#each last.linkEmbeds as link (link.url)}
                      <LinkCard url={link.url} embed={link.embed} />
                    {/each}
                  </div>
                {/if}

                {#if last.reactions && last.reactions.length > 0}
                  <!-- ReactionBar ships with `pl-12` to clear the avatar in the
                       normal chat layout. Here the bar already sits inside the
                       content column (to the right of the avatar), so cancel
                       that indent so the emoji row aligns with the message body.
                       The click handler stops the event from bubbling to the
                       enclosing `<a>` so reactions can be toggled inline
                       without navigating to the thread. -->
                  <div
                    class="-ml-12"
                    onclick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                  >
                    <MessageReactions
                      spaceId={item.spaceId}
                      roomId={item.threadId}
                      messageId={last.id}
                      reactions={last.reactions}
                      {currentUserDid}
                    />
                  </div>
                {/if}
              </div>
            </div>
            {/if}
          {/if}
        </a>
        {#if i < feed.length - 1}
          <hr class="border-base-200/50 dark:border-base-800/50" />
        {/if}
      {/each}

      <!-- End of feed notice -->
      <div class="flex justify-center py-6">
        <p class="text-sm text-base-400 italic">That's all we got.</p>
      </div>
    </div>
  {/if}
{/if}

<style>
  .prose a:hover {
    text-decoration: underline;
  }
</style>
