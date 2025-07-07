<script lang="ts">
  import { page } from "$app/state";
  import { navigateSync } from "$lib/utils.svelte";
  import { Accordion, AccordionItem, Button } from "@fuxui/base";
  import Icon from "@iconify/svelte";
  import { IDList, RoomyObject } from "@roomy-chat/sdk";
  import { CoState } from "jazz-tools/svelte";
  import SidebarObjectList from "./SidebarObjectList.svelte";

  let { id }: { id: string } = $props();

  let object = $derived(new CoState(RoomyObject, id, {
    resolve: {
      components: {
        $each: true,
        $onError: null,
      },
    }
  }));

  let children = $derived(new CoState(IDList, object.current?.components?.children));
</script>

{#if object.current?.components?.thread}
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
{:else if object.current?.components?.page}
  <Button
    href={navigateSync({
      space: page.params.space!,
      object: object.current?.id,
    })}
    variant="ghost"
    class="w-full justify-start"
    data-current={object.current?.id === page.params.object}
  >
    <Icon icon={"tabler:file-text"} class="shrink-0" />
    <span class="truncate">{object.current?.name || "..."}</span>
  </Button>
{:else if object.current}
  <Accordion type="single">
    <AccordionItem
      title={object.current?.name || "..."}
      class="border-0 w-full"
      triggerClasses="text-sm px-3 py-1 font-semibold w-full"
      contentClasses="pl-5 pr-3"
      data-current={object.current?.id === page.params.object}
    >
      <SidebarObjectList childrenIds={children.current} />
    </AccordionItem>
  </Accordion>
{/if}
