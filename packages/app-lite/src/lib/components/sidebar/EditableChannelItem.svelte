<script lang="ts">
  import { schemas } from "@roomy-space/sdk";
  import SidebarItemShell from "@roomy/design/components/sidebars/SidebarItemShell.svelte";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import { IconPencil } from "@roomy/design/icons";

  type SidebarChannel =
    typeof schemas.queries.getSpaceMetadata.SidebarChannel.infer;

  let {
    channel,
    spaceId,
    isEditing,
    active,
    onedit,
  }: {
    channel: SidebarChannel;
    spaceId: string;
    isEditing: boolean;
    active: boolean;
    onedit: (roomId: string) => void;
  } = $props();
</script>

<div class="inline-flex items-center w-full gap-1 {!channel.canRead ? 'opacity-50 pointer-events-none' : ''}">
  <div class="flex-1 min-w-0">
    <SidebarItemShell
      variant="channel"
      name={channel.name ?? channel.id}
      href={`/${spaceId}/${channel.id}`}
      active={active && !isEditing}
      hasUnreadDot={channel.unreadCount > 0 && !isEditing}
      unreadCount={channel.unreadCount}
      showUnreadCount={channel.unreadCount > 0 && !isEditing}
    />
  </div>
  {#if isEditing}
    <Button
      variant="ghost"
      size="icon"
      onclick={() => onedit(channel.id)}
      class="group-hover:opacity-100 opacity-20 shrink-0"
    >
      <IconPencil class="size-4" />
    </Button>
  {/if}
</div>
