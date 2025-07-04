<script lang="ts">
  import SidebarObject from "./SidebarObject.svelte";

  let { childrenIds }: { childrenIds: string[] } = $props();
</script>

<div class="flex flex-col gap-2 text-base-900 dark:text-base-100">
  {#each childrenIds as childId}
    <div class="flex items-center gap-2">
      <SidebarObject id={childId} />
    </div>
  {/each}
</div>
