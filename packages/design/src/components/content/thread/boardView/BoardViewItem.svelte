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
  <Box class="flex flex-col sm:flex-row sm:items-center gap-0 sm:gap-3 py-4 px-3 bg-white dark:bg-base-900">
    <!-- Top row: title + avatar -->
    <div class="flex items-center gap-3 w-full sm:w-auto sm:flex-1 sm:min-w-0">
      <div class="flex-1 min-w-0 text-ellipsis overflow-hidden whitespace-nowrap text-sm font-light dark:text-base-300">
        {#if thread.kind == "space.roomy.channel"}
          #&nbsp;
        {/if}
        {thread.name}
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
    <div class="flex sm:hidden items-center gap-2 text-xs text-base-400 dark:text-base-500 ml-0.5">
      {#if !hideChannel && thread.channelName}
        <span class="flex items-center gap-1 min-w-0 truncate whitespace-nowrap">
          <IconHashtag class="shrink-0 size-3" />
          <span class="truncate">{thread.channelName}</span>
        </span>
        <span class="text-base-300 dark:text-base-600 shrink-0">·</span>
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
      <div class="hidden sm:flex w-32 shrink-0 text-sm text-base-500 dark:text-base-300/80 items-center gap-1 overflow-hidden">
        {#if thread.channelName}
          <IconHashtag class="shrink-0 size-3" />
          <span class="min-w-0 truncate whitespace-nowrap">{thread.channelName}</span>
        {/if}
      </div>
    {/if}

    <div class="hidden sm:block w-24 shrink-0 text-right text-xs text-base-500 dark:text-base-300/80">
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
