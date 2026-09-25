<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import { schemas } from "@roomy-space/sdk";
  import ChannelIcon from "./ChannelIcon.svelte";

  type SidebarChannel = typeof schemas.queries.getSpaceMetadata.SidebarChannel.infer;

  const { Story } = defineMeta({
    title: "Sidebars/ChannelIcon",
    component: ChannelIcon,
  });

  const localChannel: SidebarChannel = {
    id: "01KZBRQMEP2FTE079YRVDFKGTA",
    name: "lobby",
    defaultAccess: "readwrite",
    canRead: true,
    canWrite: true,
    unreadCount: 0,
  };

  const federatedChannel: SidebarChannel = {
    ...localChannel,
    id: "01KZBRQMEP2FTE079YRVDFKGTC",
    name: "Weekend plans",
    federated: {
      originSpaceId: "did:plc:drzgt2m6lmcel62gfbzjeap3",
      originSpaceName: "Test Space",
      permission: "read",
    },
  };
</script>

{#snippet template(args: { channel: SidebarChannel })}
  <div class="p-4 flex items-center gap-2 text-base-900 dark:text-base-100">
    <ChannelIcon channel={args.channel} />
    <span class="text-sm">{args.channel.name}</span>
  </div>
{/snippet}

<Story name="Local" args={{ channel: localChannel }} {template} />

<Story name="Federated" args={{ channel: federatedChannel }} {template} />
