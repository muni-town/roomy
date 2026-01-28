<script lang="ts">
  import { page } from "$app/state";
  import { Badge, Box } from "@fuxui/base";
  import { formatDistanceToNowStrict, type Locale } from "date-fns";
  import type { ThreadInfo } from "./types";
  import IconHeroiconsDocument from "~icons/heroicons/document";
  import IconHeroiconsHashtag from "~icons/heroicons/hashtag";
  import AvatarGroup from "$lib/components/user/AvatarGroup.svelte";
  import type { Ulid } from "@roomy/sdk";

  let {
    thread,
    parent,
  }: { thread: ThreadInfo; activityCountMax?: number; parent?: Ulid } =
    $props();

  $effect(() => {
    console.log("boardviewitem", {
      parent,
      thread: $state.snapshot(thread),
    });
  });

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

<a
  href={`/${page.params.space}/${thread.id}${parent ? "?parent=" + parent : thread.canonicalParent ? "?parent=" + thread.canonicalParent : ""}`}
>
  <Box class="flex items-baseline p-3">
    <div
      class="flex items-center relative -bottom-1 justify-between gap-2 mr-2"
    >
      {#if thread.kind == "space.roomy.page"}
        <IconHeroiconsDocument class="shrink-0" />
      {:else if thread.kind == "space.roomy.thread"}
        <IconHeroiconsHashtag class="shrink-0" />
      {/if}
    </div>
    <div class="text-ellipsis min-w-0 shrink w-full max-w-full">
      {#if thread.kind == "space.roomy.channel"}
        #&nbsp;
      {/if}
      {thread.name}
    </div>
    {#if thread.channel}
      <Badge class="mx-2" size="sm">{thread.channel}</Badge>
    {/if}

    <div class="ml-auto flex items-center shrink-0">
      <!-- <div class="grow"></div> -->

      <div class="grow shrink-0 text-end">
        <span class="text-base-500 text-sm mr-2"
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
      </div>
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
  </Box>
</a>
