<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import BoardViewItem from "./BoardViewItem.svelte";
  import type { ThreadInfo } from "./types";

  const { Story } = defineMeta({
    title: "Content/Thread/BoardViewItem",
    component: BoardViewItem,
  });

  const thread: ThreadInfo = {
    id: "thread-1",
    name: "General chat",
    kind: "space.roomy.channel",
    channelName: "general",
    unread: true,
    activity: {
      members: [
        { avatar: "https://placehold.co/64x64/6366f1/ffffff?text=A", name: "Alice", id: "alice" },
        { avatar: "https://placehold.co/64x64/10b981/ffffff?text=B", name: "Bob", id: "bob" },
        { avatar: "https://placehold.co/64x64/f97316/ffffff?text=C", name: "Carol", id: "carol" },
      ],
      latestTimestamp: Date.now() - 1000 * 60 * 4,
    },
  };
</script>

{#snippet template(args: { thread: ThreadInfo; href: string; hideChannel: boolean })}
  <div class="w-full max-w-2xl p-4">
    <BoardViewItem
      thread={args.thread}
      href={args.href}
      hideChannel={args.hideChannel}
    />
  </div>
{/snippet}

<Story
  name="Default"
  args={{ thread, href: "#/x", hideChannel: false }}
  {template}
/>

<Story
  name="HiddenChannel"
  args={{ thread, href: "#/x", hideChannel: true }}
  {template}
/>
