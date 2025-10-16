<script lang="ts">
  import { page } from "$app/state";
  import { AvatarGroup, Box } from "@fuxui/base";
  import { formatDistanceToNowStrict, type Locale } from "date-fns";
  import type { ThreadInfo } from "./types";

  let { thread }: { thread: ThreadInfo; activityCountMax?: number } = $props();

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

<a href={`/${page.params.space}/${thread.id}`}>
  <Box class="flex items-center">
    <div class="shrink text-ellipsis min-w-0 overflow-hidden">
      {#if thread.kind == "channel"}
        #&nbsp;
      {/if}
      {thread.name}
    </div>

    <div class="flex-grow"></div>
    <div class="mr-5">
      <AvatarGroup
        avatarClass="size-8"
        users={thread.activity.members.map((m) => ({
          src: m.avatar,
          fallback: "U",
          alt: "U",
        }))}
      />
    </div>

    <div
      class={`flex items-center ${thread.channel ? "w-[14em]" : "w-[4em]"} shrink-0`}
    >
      {#if thread.channel}
        <div class="flex items-center justify-between gap-2">
          <span class="text-xl"># </span>{thread.channel}
        </div>
      {/if}

      <div class="grow"></div>

      <div>
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
    </div>
  </Box>
</a>
