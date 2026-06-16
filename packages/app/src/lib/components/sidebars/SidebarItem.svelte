<script lang="ts">
  import { page } from "$app/state";
  import { navigateSync } from "$lib/utils.svelte";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import SidebarItemShell from "@roomy/design/components/sidebars/SidebarItemShell.svelte";
  import type { SidebarItem } from "$lib/queries";
  import { flags } from "$lib/config";

  import { IconPencil } from "@roomy/design/icons";
  import LinkedRoomsList from "./LinkedRoomsList.svelte";
  import { Ulid } from "@roomy-space/sdk";

  let {
    item,
    isEditing = $bindable(false),
    editSidebarItem,
  }: {
    item: SidebarItem;
    isEditing: boolean;
    index?: number;
    editSidebarItem: (
      id: { room: Ulid } | { categoryId: Ulid; categoryName: string },
    ) => void;
  } = $props();

  let hasUnread = $derived(
    flags.unreadNotifications && item.lastRead > 0 && item.unreadCount > 0,
  );

  const itemActive = $derived(
    page.params.object === item.id ||
      page.url.searchParams.get("parent") === item.id,
  );

  const href = $derived(
    navigateSync({
      space: page.params.space!,
      object: item.id,
    }),
  );
</script>

{#snippet editButton()}
  {#if isEditing && item.type !== "space.roomy.category"}
    <Button
      variant="ghost"
      size="icon"
      onclick={() => editSidebarItem({ room: item.id as Ulid })}
      class="group-hover:opacity-100 opacity-20"
    >
      <IconPencil class="size-4" />
    </Button>
  {:else if item.type === "space.roomy.category"}{/if}
{/snippet}

{#if item.type == "space.roomy.channel"}
  <SidebarItemShell
    variant="channel"
    name={item.name}
    {href}
    active={item.id === page.params.object && !isEditing}
    hasUnreadDot={hasUnread && !isEditing && item.id !== page.params.object}
    hasUnread={hasUnread && !isEditing && item.id !== page.params.object}
    trailing={editButton}
  >
    {#if itemActive && !isEditing}
      <LinkedRoomsList bind:roomId={item.id as Ulid} />
    {/if}
  </SidebarItemShell>
{:else if item.type == "space.roomy.page"}
  <SidebarItemShell
    variant="page"
    name={item.name}
    {href}
    active={item.id === page.params.object && !isEditing}
    trailing={editButton}
  />
{/if}
