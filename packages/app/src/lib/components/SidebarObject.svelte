<script lang="ts">
  import { page } from "$app/state";
  import { navigateSync } from "$lib/utils.svelte";
  import { Accordion, AccordionItem, Button } from "@fuxui/base";
  import Icon from "@iconify/svelte";
  import { IDList, RoomyObject, Space } from "@roomy-chat/sdk";
  import { CoState } from "jazz-svelte";
  import { co, z } from "jazz-tools";
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
  
  // For feed aggregators, just show a simple count for now (avoid IndexedDB transaction issues)
  let childrenThreads = $derived(null); // Disable for now to avoid DB transaction errors

  // Simplified count (no nested display for now)
  let childrenCount = $derived(() => {
    // For now, just return 0 to avoid IndexedDB transaction issues
    // We'll show feed threads as top-level items instead of nested
    return 0;
  });

  // Removed accordion state - using simple indented layout

  // Clean implementation - no debug effects needed
</script>

{#if object.current?.components?.feedConfig}
  <!-- Feed aggregator - always show as clickable button -->
  <Button
    href={navigateSync({
      space: page.params.space!,
      object: object.current?.id,
    })}
    variant="ghost"
    class="w-full justify-start"
    data-current={object.current?.id === page.params.object}
  >
    <Icon icon="tabler:rss" class="shrink-0" />
    <span class="truncate">{object.current?.name || "..."}</span>
    {#if childrenCount() > 0}
      <span class="text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-200 px-1.5 py-0.5 rounded-full ml-auto">
        {childrenCount()}
      </span>
    {/if}
  </Button>
  
  <!-- Child feed threads disabled for now to avoid IndexedDB issues -->
  <!-- Feed threads will appear as top-level items instead of nested -->
{:else if object.current?.components?.thread}
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
