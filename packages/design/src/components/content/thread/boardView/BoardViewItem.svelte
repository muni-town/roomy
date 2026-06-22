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
  <Box class="flex items-center gap-3 py-4 px-3 bg-white dark:bg-base-900">
    <!-- Column 1: Title (grows) -->
    <div class="flex-1 min-w-0 text-ellipsis overflow-hidden whitespace-nowrap text-sm font-light dark:text-base-300">
      {#if thread.kind == "space.roomy.channel"}
        #&nbsp;
      {/if}
      {thread.name}
    </div>

    <!-- Column 2: Avatar stack -->
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

    <!-- Column 3: Parent channel -->
    {#if !hideChannel}
      <div class="w-32 shrink-0 text-sm text-base-500 dark:text-base-300/80 truncate flex items-center gap-1">
        {#if thread.channelName}
          <IconHashtag class="shrink-0 size-3" />
          {thread.channelName}
        {/if}
      </div>
    {/if}

    <!-- Column 4: Date last active -->
    <div class="w-24 shrink-0 text-right text-xs text-base-500 dark:text-base-300/80">
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
