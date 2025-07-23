<script lang="ts">
  import { RoomyEntity } from "@roomy-chat/sdk";
  import { navigateSync } from "$lib/utils.svelte";
  import { Button } from "@fuxui/base";
  import { CoState } from "jazz-tools/svelte";

  let { threadId, spaceId }: { threadId: string; spaceId: string } = $props();

  const thread = $derived(new CoState(RoomyEntity, threadId));
</script>

<Button
  class="w-fit ml-14"
  size="sm"
  href={navigateSync({
    space: spaceId,
    object: threadId,
  })}
>
  New thread: {thread.current?.name}
</Button>
