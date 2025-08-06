<script lang="ts">
  import { RoomyEntity } from "@roomy-chat/sdk";
  import { navigateSync } from "$lib/utils.svelte";
  import { Button } from "@fuxui/base";
  import { CoState } from "jazz-tools/svelte";
  import Icon from "@iconify/svelte";

  let { threadId, spaceId }: { threadId: string; spaceId: string } = $props();

  const thread = $derived(new CoState(RoomyEntity, threadId));
</script>

<Button
  class="w-fit ml-12 -mt-2 mb-2"
  size="sm"
  href={navigateSync({
    space: spaceId,
    object: threadId,
  })}
>
  <Icon icon="tabler:corner-down-right" />
  {thread.current?.name}
</Button>
