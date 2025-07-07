<script lang="ts">
  import { page } from "$app/state";
  import { navigateSync } from "$lib/utils.svelte";
  import { Button } from "@fuxui/base";
  import Icon from "@iconify/svelte";
  import { RoomyObject } from "@roomy-chat/sdk";
  import { CoState } from "jazz-svelte";

  let { id }: { id: string } = $props();

  let object = $derived(new CoState(RoomyObject, id));
</script>

{#if object.current?.content?.thread}
  <Button
    href={navigateSync({
      space: page.params.space!,
      object: object.current?.id,
    })}
    variant="ghost"
    class="w-full justify-start"
    data-current={object.current?.id === page.params.object}
  >
    <Icon icon={"tabler:message-circle"} class="shrink-0" />
    <span class="truncate">{object.current?.name || "..."}</span>
  </Button>
{/if}
