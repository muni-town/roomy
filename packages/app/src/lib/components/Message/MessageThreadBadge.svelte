<script lang="ts">
  import { Thread } from "$lib/jazz/schema";
  import { navigateSync } from "$lib/utils.svelte";
  import { Button } from "bits-ui";
  import { CoState } from "jazz-svelte";

  let { threadId, spaceId }: { threadId: string; spaceId: string } = $props();

  const thread = $derived(new CoState(Thread, threadId));
</script>

<Button.Root
  class="text-xs dz-badge text-base-100 font-semibold dz-badge-primary ml-14"
  href={navigateSync({
    space: spaceId,
    thread: threadId,
  })}
>
  New thread: {thread.current?.name}
</Button.Root>
