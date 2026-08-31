<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import SidebarItemShell from "./SidebarItemShell.svelte";
  import LinkedRoomList from "./LinkedRoomList.svelte";

  const { Story } = defineMeta({
    title: "Sidebars/SidebarItemShell",
    component: SidebarItemShell,
  });

  type Args = {
    variant: "channel" | "page";
    name: string;
    href: string;
    active: boolean;
    hasUnreadDot: boolean;
    hasUnread: boolean;
  };
</script>

{#snippet template(args: Args)}
  <div class="p-4 w-64">
    <SidebarItemShell
      {...(args as any)}
      onclick={() => {
        /* no-op in story */
      }}
    />
  </div>
{/snippet}

<Story
  name="Channel"
  args={{
    variant: "channel",
    name: "General",
    href: "#/general",
    active: true,
    hasUnreadDot: true,
    hasUnread: true,
  }}
  {template}
/>

<Story
  name="ChannelPlain"
  args={{
    variant: "channel",
    name: "General",
    href: "#/general",
    active: false,
    hasUnreadDot: false,
    hasUnread: false,
  }}
  {template}
/>

<Story
  name="Page"
  args={{
    variant: "page",
    name: "Index",
    href: "#/index",
    active: false,
    hasUnreadDot: false,
    hasUnread: false,
  }}
  {template}
/>

<Story
  name="WithLinkedRooms"
  args={{
    variant: "channel",
    name: "Threads",
    href: "#/threads",
    active: true,
    hasUnreadDot: false,
    hasUnread: false,
  }}
>
  {#snippet children()}
    <LinkedRoomList
      rooms={[
        { id: "r1", name: "Weekend plans", unreadCount: 2, lastRead: 1725062400000 },
        { id: "r2", name: "Books", unreadCount: 0, lastRead: 1725062400000 },
      ]}
      currentRoomId="r1"
      hrefFor={(id: string) => `#/${id}`}
    />
  {/snippet}
</Story>
