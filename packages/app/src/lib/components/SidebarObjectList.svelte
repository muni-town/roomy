<script lang="ts">
  import type { co } from "jazz-tools";
  import SidebarObject from "./SidebarObject.svelte";
  import type { IDList } from "@roomy-chat/sdk";

  let {
    childrenIds,
  }: { childrenIds: co.loaded<typeof IDList> | undefined | null } = $props();
</script>

<div class="flex flex-col gap-2 text-base-900 dark:text-base-100">
  {#each childrenIds ?? [] as childId}
    <div class="flex items-center gap-2">
      <SidebarObject id={childId} />
    </div>
  {/each}
  {#if childrenIds?.length === 0}
    <p class="text-sm text-base-500">No objects found</p>
  {/if}
</div>
