<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import LinkedRoomList from "./LinkedRoomList.svelte";

  const { Story } = defineMeta({
    title: "Sidebars/LinkedRoomList",
    component: LinkedRoomList,
  });

  type Args = {
    rooms: { id: string; name: string; unreadCount: number; lastRead: number }[];
    currentRoomId: string;
  };
</script>

{#snippet template(args: Args)}
  <div class="p-4 w-64">
    <div
      class="rounded-lg border border-base-200 dark:border-base-800 bg-base-50 dark:bg-base-950 p-2"
    >
      <p class="text-[11px] font-semibold uppercase tracking-wider text-base-400 px-1 pb-2">
        Linked rooms
      </p>
      <LinkedRoomList
        {...(args as any)}
        hrefFor={(id: string) => `#/${id}`}
      />
    </div>
  </div>
{/snippet}

<Story
  name="Default"
  args={{
    rooms: [
      { id: "r1", name: "General", unreadCount: 0, lastRead: 1725062400000 },
      { id: "r2", name: "Random", unreadCount: 3, lastRead: 1725062400000 },
      { id: "r3", name: "Design", unreadCount: 12, lastRead: 1725062400000 },
    ],
    currentRoomId: "r1",
  }}
  {template}
/>
