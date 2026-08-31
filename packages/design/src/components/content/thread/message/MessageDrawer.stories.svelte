<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import MessageDrawer from "./MessageDrawer.svelte";

  const { Story } = defineMeta({
    title: "Content/Thread/Message/MessageDrawer",
    component: MessageDrawer,
  });
</script>

<Story
  name="Default"
  args={{
    visible: true,
    open: true,
    canEdit: true,
    canDelete: true,
    onToggleReaction: () => {},
    onReply: () => {},
    onForward: () => {},
    onStartThreading: () => {},
    onEdit: () => {},
    onDelete: () => {},
  }}
/>

<Story
  name="Closed"
  args={{
    visible: true,
    open: false,
    canEdit: true,
    canDelete: true,
    onToggleReaction: () => {},
    onReply: () => {},
    onForward: () => {},
    onStartThreading: () => {},
    onEdit: () => {},
    onDelete: () => {},
  }}
/>
