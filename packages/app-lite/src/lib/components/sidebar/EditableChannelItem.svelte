<script lang="ts">
  import { schemas } from "@roomy-space/sdk";
  import SidebarItemShell from "@roomy/design/components/sidebars/SidebarItemShell.svelte";
  import { IconSettings } from "@roomy/design/icons";

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
    spaceId: string | undefined;
    isEditing: boolean;
    active: boolean;
    onedit: (roomId: string) => void;
  } = $props();
</script>

<div class="inline-flex items-center w-full gap-1 group {!channel.canRead ? 'opacity-50 pointer-events-none' : ''}">
  <div class="flex-1 min-w-0">
    <SidebarItemShell
      variant="channel"
      name={channel.name ?? channel.id}
      href={isEditing ? undefined : `/${spaceId}/${channel.id}`}
      active={active && !isEditing}
      hasUnreadDot={channel.unreadCount > 0 && !isEditing}
      hasUnread={channel.unreadCount > 0 && !isEditing}
      plain={isEditing}
      onclick={isEditing ? () => onedit(channel.id) : undefined}
    />
  </div>
  {#if isEditing}
    <button
      type="button"
      onclick={() => onedit(channel.id)}
      aria-label="Edit channel"
      class="shrink-0 p-1 text-base-400 dark:text-base-500 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-hover:text-base-600 sm:group-hover:dark:text-base-300 cursor-pointer"
    >
      <IconSettings class="size-4" />
    </button>
  {/if}
</div>
