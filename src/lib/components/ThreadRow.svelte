<script lang="ts">
  import Icon from "@iconify/svelte";
  import type { Ulid, Thread } from "$lib/schemas/types";

  let { id, thread, onclick }: { id: Ulid, thread: Thread, onclick: () => void } = $props();
</script>

<button {id} {onclick} class="cursor-pointer text-white flex w-full justify-between p-4 hover:bg-white/5 transition-all duration-75">
  <h1 class="text-xl font-semibold">{thread.title}</h1>
  <p class="flex gap-2 items-center">
    {thread.timeline.length}
    <Icon icon="tabler:message" />
  </p>
</button>