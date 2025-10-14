<script lang="ts">
  import { page } from "$app/state";
  import { AvatarGroup, Box } from "@fuxui/base";
  import { formatDistance } from "date-fns";
  import type { ThreadInfo } from "./types";

  let { thread }: { thread: ThreadInfo } = $props();

  let lastMessageTimestamp = $derived(thread.activity.latestTimestamp);
</script>

<a href={`/${page.params.space}/${thread.id}`}>
  <Box class="flex items-center">
    {thread.name}
    {#if thread.channel}
      <span class="text-xl ml-4 mr-1"># </span>{thread.channel}
    {/if}
    <span class="flex-grow"></span>
    <span class="mr-8">
      <AvatarGroup
        users={thread.activity.members.map((m) => ({
          src: m.avatar,
          fallback: "U",
          alt: "U",
        }))}
      />
    </span>
    {#if lastMessageTimestamp}
      {formatDistance(new Date(Date.now()), lastMessageTimestamp)}
    {/if}
  </Box>
</a>
