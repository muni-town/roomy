<script lang="ts">
  import type { co } from "jazz-tools";
  import SidebarObject from "./SidebarObject.svelte";
  import type { ChildrenComponent, RoomyAccount } from "@roomy-chat/sdk";

  let {
    children,
    me,
  }: {
    children: co.loaded<typeof ChildrenComponent.schema> | undefined | null;
    me: co.loaded<typeof RoomyAccount> | undefined | null;
  } = $props();
</script>

<div class="flex flex-col gap-2 text-base-900 dark:text-base-100 w-full">
  {#each children ?? [] as child}
    <div class="flex items-center gap-2 w-full">
      <SidebarObject object={child} {me} />
    </div>
  {/each}
</div>
