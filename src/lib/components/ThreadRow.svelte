<script lang="ts">
  import Icon from "@iconify/svelte";
  import type { Ulid, Thread } from "$lib/schemas/types";
  import { decodeTime } from "ulidx";
  import { formatDistanceToNowStrict } from "date-fns";

  let { id, thread, onclick }: { id: Ulid, thread: Thread, onclick: () => void } = $props();
  let latest = $derived.by(() => {
    let allTime: number[] = [];
    for (const id of thread.timeline) {
      allTime.push(decodeTime(id));
    }
    allTime.sort();
    return new Date(allTime[allTime.length-1]);
  });

  $inspect({ latest })
</script>

<button {id} {onclick} class="border border-white rounded cursor-pointer text-white flex w-full justify-between p-4 hover:bg-white/5 transition-all duration-75">
  <div class="flex gap-4 items-center">
    <h1 class="text-xl font-semibold">{thread.title}</h1>
    <time class="text-sm text-gray-300">Latest: {formatDistanceToNowStrict(latest)} ago</time>
  </div>
  <p class="flex gap-2 items-center">
    {thread.timeline.length}
    <Icon icon="tabler:message" />
  </p>
</button>