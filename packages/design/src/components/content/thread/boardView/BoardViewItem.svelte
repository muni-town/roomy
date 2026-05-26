<script lang="ts">
  import { Box } from "@foxui/core";
  import Badge from "../../../ui/badge/Badge.svelte";
  import { formatDistanceToNowStrict, type Locale } from "date-fns";
  import type { ThreadInfo } from "./types";
  import { IconDocument, IconHashtag } from "../../../../icons/index";
  import AvatarGroup from "../../../user/AvatarGroup.svelte";

  let {
    thread,
    href,
  }: { thread: ThreadInfo; href: string } = $props();

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
  <Box class="flex items-baseline gap-1 p-3 bg-white dark:bg-base-900">
    <!-- <div
      class="flex items-center relative -bottom-1 justify-between gap-2 mr-2"
    >
      {#if thread.kind == "space.roomy.page"}
        <IconDocument class="shrink-0" />
      {:else if thread.kind == "space.roomy.thread"}{/if}
    </div> -->
    <div class="text-ellipsis min-w-0 shrink text-xl font-bold">
      {#if thread.kind == "space.roomy.channel"}
        #&nbsp;
      {/if}
      {thread.name}
    </div>
    <span class="text-base-500 text-xs"
      >{#if lastMessageTimestamp}
        {#if Date.now() - lastMessageTimestamp < 60 * 1000}
          Just Now
        {:else}
          {formatDistanceToNowStrict(lastMessageTimestamp, {
            locale: formatDistanceLocale,
          })}
        {/if}
      {/if}</span
    >

    <div class="ml-auto flex self-center items-center shrink-0">
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
      <div class="flex justify-between text-end">
        {#if thread.channel}
          <Badge class="mx-2" size="sm" variant="secondary"
            ><IconHashtag
              class="shrink-0 size-3 -mr-1"
            />{thread.channel}</Badge
          >
        {/if}
      </div>
    </div>
  </Box>
</a>
