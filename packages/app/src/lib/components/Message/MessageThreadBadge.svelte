<script lang="ts">
  import { Thread } from "$lib/jazz/schema";
  import { navigateSync } from "$lib/utils.svelte";
  import { Button } from "@fuxui/base";
  import { CoState } from "jazz-svelte";

  let { threadId, spaceId }: { threadId: string; spaceId: string } = $props();

  const thread = $derived(new CoState(Thread, threadId));
</script>

<Button
  class="w-fit ml-14"
  size="sm"
  href={navigateSync({
    space: spaceId,
    thread: threadId,
  })}
>
  New thread: {thread.current?.name}
</Button>
