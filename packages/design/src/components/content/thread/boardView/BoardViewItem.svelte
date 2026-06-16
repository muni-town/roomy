<script lang="ts">
  import SpaceAvatar from "../../../spaces/SpaceAvatar.svelte";
  import { renderMarkdownSanitized } from "../../../../utils/index.js";
  import type { ThreadInfo } from "./types";

  let {
    thread,
    href,
    onAvatarClick,
  }: { thread: ThreadInfo; href: string; onAvatarClick?: (did: string) => void } = $props();

  let lastMessageTimestamp = $derived(thread.activity.latestTimestamp);

  function timeAgo(ts: number): string {
    const ms = Date.now() - ts;
    const mins = Math.floor(ms / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(ts).toLocaleDateString();
  }
</script>

<a
  {href}
  class="flex flex-col gap-2 p-4 transition-colors group no-underline hover:bg-base-100 dark:hover:bg-base-800/40 hover:shadow-[2px_2px_0_0_var(--color-base-300)] dark:hover:shadow-[2px_2px_0_0_var(--color-base-800)]"
>
  <!-- Header: thread name + timestamp -->
  <div class="flex items-center gap-2 text-xs flex-nowrap">
    <span class="truncate text-lg font-bold min-w-0">
      {#if thread.kind === "space.roomy.channel"}#&nbsp;{/if}
      {thread.name}
    </span>
    {#if thread.channelName}
      <span class="truncate text-lg font-bold opacity-70 min-w-0 shrink-0 max-w-[40%]">/ {thread.channelName}</span>
    {/if}

    {#if thread.unreadCount && thread.unreadCount > 0}
      <span
        class="inline-flex items-center shrink-0 rounded-full bg-accent-200 dark:bg-accent-600 px-2 py-0.5 text-xs font-semibold text-black/50 dark:text-white"
      >
        {thread.unreadCount} unread
      </span>
    {/if}

    <span class="ml-auto shrink-0 opacity-70 whitespace-nowrap">
      {#if lastMessageTimestamp}
        {timeAgo(lastMessageTimestamp)}
      {/if}
    </span>
  </div>

  <!-- Latest message -->
  {#if thread.activity.latestMessage}
    {@const msg = thread.activity.latestMessage}
    <div class="flex items-start gap-2 text-sm pl-1">
      <button
        onclick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onAvatarClick?.(msg.author.did);
        }}
        class="mt-0.75 rounded-full hover:ring-2 hover:ring-accent-500 transition-all cursor-pointer shrink-0"
      >
        <SpaceAvatar
          src={msg.author.avatar}
          id={msg.author.did}
          name={msg.author.name ?? undefined}
          size={18}
        />
      </button>
      <div class="min-w-0">
        <span class="font-medium text-base-700 dark:text-base-300">
          {msg.author.name ?? msg.author.did.slice(0, 8)}
        </span>
        <span class="text-base-600 dark:text-base-400 break-words [&_p]:inline [&_p]:m-0">
          {@html renderMarkdownSanitized(msg.content)}
        </span>
      </div>
    </div>
  {:else if thread.activity.members.length > 0}
    <div class="flex items-start gap-2 text-sm pl-1 opacity-60">
      <span class="text-base-500 italic">No messages yet</span>
    </div>
  {/if}
</a>
