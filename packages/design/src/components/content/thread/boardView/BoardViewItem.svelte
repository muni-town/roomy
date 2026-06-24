<script lang="ts">
  import { Box } from "@foxui/core";
  import { formatDistanceToNowStrict, type Locale } from "date-fns";
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

  const formatDistanceLocale: Pick<Locale, "formatDistance"> = {
    formatDistance: (token, count) => {
      let name = "min";
      switch (token) {
        case "xMinutes":
          name = "mins";
          break;
        case "xHours":
          name = "hrs";
          break;
        case "xDays":
          name = "days";
          break;
        case "xMonths":
          name = "months";
          break;
        case "xYears":
          name = "yrs";
          break;
        default:
          name = token;
      }

      return `${count} ${name}`;
    },
  };
</script>

<a {href}>
  <Box class="flex flex-col sm:flex-row sm:items-center gap-0 sm:gap-3 py-4 px-3 rounded-lg transition-colors bg-transparent dark:bg-transparent border-base-200 dark:border-base-800 hover:bg-base-50 dark:hover:bg-base-800/50">
    <!-- Top row: title + avatar -->
    <div class="flex items-center gap-3 w-full sm:w-auto sm:flex-1 sm:min-w-0">
      <div class={"flex-1 min-w-0 flex items-center gap-2 text-base font-light " + (read ? "text-base-500 dark:text-base-400" : "text-base-900 dark:text-base-100")}>
        <span class="truncate">
          {#if thread.kind == "space.roomy.channel"}
            #&nbsp;
          {/if}
          {thread.name}
        </span>
        {#if thread.unread}
          <span class="shrink-0 size-2 rounded-full bg-accent-500" aria-label="Unread"></span>
        {/if}
      </div>

      <div class="w-28 shrink-0 flex items-center justify-end">
        <AvatarGroup
          avatarClass="size-8"
          users={thread.activity.members
            .filter((x) => !!x.avatar)
            .map((m) => ({
              src: m.avatar!,
              id: m.id,
              alt: "User Avatar for " + (m.name || "Unknown User"),
            }))}
        />
      </div>
    </div>

    <!-- Mobile sub-row: channel + date (smaller, lower contrast) -->
    <div class={"flex sm:hidden items-center gap-2 text-xs ml-0.5 " + (read ? "text-base-400 dark:text-base-500" : "text-base-400 dark:text-base-400")}>
      {#if !hideChannel && thread.channelName}
        <span class="flex items-center gap-1 min-w-0 truncate whitespace-nowrap">
          <IconHashtag class="shrink-0 size-3" />
          <span class="truncate">{thread.channelName}</span>
        </span>
        <span class={"shrink-0 " + (read ? "text-base-300 dark:text-base-600" : "text-base-300 dark:text-base-500")}>·</span>
      {/if}
      <span>
        {#if lastMessageTimestamp}
          {#if Date.now() - lastMessageTimestamp < 60 * 1000}
            Just Now
          {:else}
            {formatDistanceToNowStrict(lastMessageTimestamp, {
              locale: formatDistanceLocale,
            })}
          {/if}
        {/if}
      </span>
    </div>

    <!-- Desktop columns (hidden on mobile) -->
    {#if !hideChannel}
      <div class={"hidden sm:flex w-[5.5rem] shrink-0 text-sm items-center gap-1 overflow-hidden " + (read ? "text-base-400 dark:text-base-500" : "text-base-500 dark:text-base-300/80")}>
        {#if thread.channelName}
          <IconHashtag class="shrink-0 size-3" />
          <span class="min-w-0 truncate whitespace-nowrap">{thread.channelName}</span>
        {/if}
      </div>
    {/if}

    <div class={"hidden sm:block w-[4.5rem] shrink-0 text-right text-xs " + (read ? "text-base-400 dark:text-base-500" : "text-base-500 dark:text-base-300/80")}>
      {#if lastMessageTimestamp}
        {#if Date.now() - lastMessageTimestamp < 60 * 1000}
          Just Now
        {:else}
          {formatDistanceToNowStrict(lastMessageTimestamp, {
            locale: formatDistanceLocale,
          })}
        {/if}
      {/if}
    </div>
  </Box>
</a>
