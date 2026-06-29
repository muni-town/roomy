<script lang="ts">
  import { formatRelativeTime } from "../../../utils/date.js";
  import type { ThreadInfo } from "./types";
  import { IconHashtag } from "../../../../icons/index";
  import AvatarGroup from "../../../user/AvatarGroup.svelte";

  let {
    thread,
    href,
    hideChannel = false,
  }: { thread: ThreadInfo; href: string; hideChannel?: boolean } = $props();

  let lastMessageTimestamp = $derived(thread.activity.latestTimestamp);
  let read = $derived(!thread.unread);
</script>

<a
  {href}
  class="group flex flex-row items-stretch border-b border-base-200/70 dark:border-base-800/70 transition-colors hover:bg-base-50 dark:hover:bg-base-800/30"
>
  {#snippet avatarGroup()}
    <AvatarGroup
      avatarClass="size-7 @[40rem]:size-8"
      users={thread.activity.members
        .filter((x) => !!x.avatar)
        .map((m) => ({
          src: m.avatar!,
          id: m.id,
          alt: "User Avatar for " + (m.name || "Unknown User"),
        }))}
    />
  {/snippet}
  <!-- Unread marker column -->
  <div class="w-6 shrink-0 flex items-center justify-start pl-2">
    {#if thread.unread}
      <span class="size-2 rounded-full bg-accent-500" aria-label="Unread"></span>
    {/if}
  </div>

  <div class="flex flex-row items-center gap-3 py-3 pl-1 pr-3 flex-1 min-w-0">
    <!-- Text column: title + mobile sub-row -->
    <div class="flex flex-col flex-1 min-w-0">
      <div class={"flex-1 min-w-0 flex items-center gap-2 text-base font-light " + (read ? "text-base-600/90 dark:text-base-400" : "text-base-900 dark:text-base-100")}>
        <span class="truncate">
          {#if thread.kind == "space.roomy.channel"}
            #&nbsp;
          {/if}
          {thread.name}
        </span>
      </div>

      <!-- Mobile sub-row: channel + date (smaller, lower contrast) -->
      <div class={"flex @[40rem]:hidden items-center gap-2 text-xs ml-0.5 " + (read ? "text-base-400 dark:text-base-500" : "text-base-500 dark:text-base-400")}>
        {#if !hideChannel && thread.channelName}
          <span class="flex items-center gap-1 min-w-0 truncate whitespace-nowrap">
            <IconHashtag class="shrink-0 size-3" />
            <span class="truncate">{thread.channelName}</span>
          </span>
          <span class={"shrink-0 " + (read ? "text-base-300 dark:text-base-600" : "text-base-300 dark:text-base-500")}>·</span>
        {/if}
        <span>
          {#if lastMessageTimestamp}
            {formatRelativeTime(new Date(lastMessageTimestamp))}
          {/if}
        </span>
      </div>
    </div>

    <!-- Mobile avatar (vertically centered, hidden on desktop) -->
    <div class={"flex items-center shrink-0 @[40rem]:hidden transition-all " + (read ? "opacity-80 saturate-75" : "opacity-100 saturate-100") + " group-hover:opacity-100 group-hover:saturate-100"}>
      {@render avatarGroup()}
    </div>

    <!-- Desktop columns (hidden on mobile) -->
    <div class={"hidden @[40rem]:flex w-16 shrink-0 items-center justify-start transition-all " + (read ? "opacity-80 saturate-75" : "opacity-100 saturate-100") + " group-hover:opacity-100 group-hover:saturate-100"}>
      {@render avatarGroup()}
    </div>

    {#if !hideChannel}
      <div class={"hidden @[40rem]:flex w-[5.5rem] shrink-0 text-sm items-center gap-1 overflow-hidden " + (read ? "text-base-500 dark:text-base-500" : "text-base-600 dark:text-base-300/80")}>
        {#if thread.channelName}
          <IconHashtag class="shrink-0 size-3" />
          <span class="min-w-0 truncate whitespace-nowrap">{thread.channelName}</span>
        {/if}
      </div>
    {/if}

    <div class={"hidden @[40rem]:block w-[4.5rem] shrink-0 text-left text-xs " + (read ? "text-base-500 dark:text-base-500" : "text-base-600 dark:text-base-300/80")}>
      {#if lastMessageTimestamp}
        {formatRelativeTime(new Date(lastMessageTimestamp))}
      {/if}
    </div>
  </div>
</a>
