<script lang="ts">
  import type { co } from "jazz-tools";
  import SidebarObject from "./SidebarObject.svelte";
  import type { IDList, RoomyAccount } from "@roomy-chat/sdk";

  let {
    childrenIds,
    me,
  }: {
    childrenIds: co.loaded<typeof IDList> | undefined | null;
    me: co.loaded<typeof RoomyAccount> | undefined | null;
  } = $props();
</script>

<div class="flex flex-col gap-2 text-base-900 dark:text-base-100 w-full">
  {#each childrenIds ?? [] as childId}
    <div class="flex items-center gap-2 w-full">
      <SidebarObject id={childId} {me} />
    </div>
  {/each}
</div>
