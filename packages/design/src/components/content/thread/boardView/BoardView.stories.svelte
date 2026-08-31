<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import BoardView from "./BoardView.svelte";
  import type { ThreadInfo } from "./types";

  const { Story } = defineMeta({
    title: "Content/Thread/BoardView",
    component: BoardView,
  });

  const threads: ThreadInfo[] = [
    {
      id: "thread-1",
      name: "General chat",
      kind: "space.roomy.channel",
      channelName: "general",
      unread: true,
      activity: {
        members: [
          { avatar: "https://placehold.co/64x64/6366f1/ffffff?text=A", name: "Alice", id: "alice" },
          { avatar: "https://placehold.co/64x64/10b981/ffffff?text=B", name: "Bob", id: "bob" },
        ],
        latestTimestamp: Date.now() - 1000 * 60 * 5,
      },
    },
    {
      id: "thread-2",
      name: "Show and tell",
      kind: "space.roomy.thread",
      channelName: "general",
      activity: {
        members: [
          { avatar: "https://placehold.co/64x64/f97316/ffffff?text=C", name: "Carol", id: "carol" },
        ],
        latestTimestamp: Date.now() - 1000 * 60 * 60 * 2,
      },
    },
    {
      id: "thread-3",
      name: "Roadmap planning",
      kind: "space.roomy.page",
      channelName: "work",
      unread: true,
      activity: {
        members: [
          { avatar: "https://placehold.co/64x64/8b5cf6/ffffff?text=D", name: "Dan", id: "dan" },
          { avatar: "https://placehold.co/64x64/ec4899/ffffff?text=A", name: "Alice", id: "alice" },
          { avatar: "https://placehold.co/64x64/06b6d4/ffffff?text=E", name: "Eve", id: "eve" },
        ],
        latestTimestamp: Date.now() - 1000 * 60 * 60 * 26,
      },
    },
    {
      id: "thread-4",
      name: "Weekend plans",
      kind: "space.roomy.thread",
      activity: {
        members: [{ avatar: null, name: "Zoe", id: "zoe" }],
        latestTimestamp: Date.now() - 1000 * 60 * 60 * 50,
      },
    },
  ];
</script>

<Story
  name="Default"
  args={{
    threads,
    emptyMessage: "No items",
    hrefFor: (t: ThreadInfo) => `#/${t.id}`,
    hideChannel: false,
    hasMore: true,
    loadMore: () => {},
  }}
/>

{#snippet template(args: { threads: ThreadInfo[]; emptyMessage: string; hasMore: boolean })}
  <div class="h-96 w-full">
    <BoardView
      threads={args.threads}
      emptyMessage={args.emptyMessage}
      hrefFor={(t) => `#/${t.id}`}
      hasMore={args.hasMore}
      loadMore={() => {}}
    />
  </div>
{/snippet}

<Story
  name="Empty"
  args={{ threads: [], emptyMessage: "No threads yet", hasMore: false }}
  {template}
/>
