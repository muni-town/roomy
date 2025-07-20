<script lang="ts">
  import type { co } from "jazz-tools";
  import SidebarObject from "./SidebarObject.svelte";
  import type { ChildrenComponent, RoomyAccount, RoomyEntity } from "@roomy-chat/sdk";

  let {
    children,
    me,
    isEditing = $bindable(false),
    editEntity
  }: {
    children: co.loaded<typeof ChildrenComponent.schema> | undefined | null;
    me: co.loaded<typeof RoomyAccount> | undefined | null;
    isEditing?: boolean;
    editEntity?: (entity: co.loaded<typeof RoomyEntity>) => void;
  } = $props();
</script>

<div class="flex flex-col gap-2 text-base-900 dark:text-base-100 w-full">
  {#each children ?? [] as child}
    <div class="flex items-center gap-2 w-full">
      <SidebarObject object={child} {me} bind:isEditing {editEntity} />
    </div>
  {/each}
</div>
