<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import { schemas } from "@roomy-space/sdk";
  import EditableChannelItem from "./EditableChannelItem.svelte";

  type SidebarChannel = typeof schemas.queries.getSpaceMetadata.SidebarChannel.infer;

  const { Story } = defineMeta({
    title: "Sidebars/EditableChannelItem",
    component: EditableChannelItem,
  });

  const spaceId = "did:plc:drzgt2m6lmcel62gfbzjeap3";

  const activeChannel: SidebarChannel = {
    id: "01KZBRQMEP2FTE079YRVDFKGTA",
    name: "lobby",
    defaultAccess: "readwrite",
    canRead: true,
    canWrite: true,
    unreadCount: 0,
  };

  const unreadChannel: SidebarChannel = {
    ...activeChannel,
    id: "01KZBRQMEP2FTE079YRVDFKGTC",
    name: "announcements",
    unreadCount: 3,
  };

  const unreadableChannel: SidebarChannel = {
    ...activeChannel,
    id: "01KZBRQMEP2FTE079YRVDFKGTE",
    name: "staff-only",
    canRead: false,
  };

  const noop = () => {
    /* no-op in story */
  };
</script>

{#snippet template(args: {
  channel: SidebarChannel;
  isEditing: boolean;
  active: boolean;
})}
  <div class="p-4 w-64 bg-base-50 dark:bg-base-950">
    <EditableChannelItem
      channel={args.channel}
      {spaceId}
      isEditing={args.isEditing}
      active={args.active}
      onedit={noop}
    />
  </div>
{/snippet}

<Story
  name="Active"
  args={{ channel: activeChannel, isEditing: false, active: true }}
  {template}
/>

<Story
  name="Unread"
  args={{ channel: unreadChannel, isEditing: false, active: false }}
  {template}
/>

<Story
  name="NotReadable"
  args={{ channel: unreadableChannel, isEditing: false, active: false }}
  {template}
/>

<Story
  name="Editing"
  args={{ channel: activeChannel, isEditing: true, active: false }}
  {template}
/>
