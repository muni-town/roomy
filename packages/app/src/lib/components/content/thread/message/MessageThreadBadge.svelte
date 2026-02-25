<script lang="ts">
  import { RoomyEntity } from "@roomy-chat/sdk";
  import { navigateSync } from "$lib/utils.svelte";
  import Button from "$lib/components/ui/button/Button.svelte";
  import { CoState } from "jazz-tools/svelte";
  import Icon from "@iconify/svelte";

  let { threadId, spaceId }: { threadId: string; spaceId: string } = $props();

  const thread = $derived(new CoState(RoomyEntity, threadId));
</script>

<Button
  class="w-fit ml-12 -mt-2 mb-2 max-w-48 truncate"
  size="sm"
  href={navigateSync({
    space: spaceId,
    object: threadId,
  })}
>
  <Icon icon="tabler:corner-down-right" />
  <span class="truncate max-w-full">{thread.current?.name}</span>
</Button>
