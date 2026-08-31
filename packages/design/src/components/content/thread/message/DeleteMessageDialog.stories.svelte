<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import DeleteMessageDialog from "./DeleteMessageDialog.svelte";

  const { Story } = defineMeta({
    title: "Content/Thread/Message/DeleteMessageDialog",
    component: DeleteMessageDialog,
  });
</script>

<Story
  name="Default"
  args={{
    open: true,
    authorName: "Alice",
    isAdminDelete: false,
    onConfirm: async () => {},
  }}
/>

<Story
  name="AdminDelete"
  args={{
    open: true,
    authorName: "Bob",
    isAdminDelete: true,
    onConfirm: async () => {},
  }}
/>

<Story
  name="Closed"
  args={{
    open: false,
    authorName: "Alice",
    isAdminDelete: false,
    onConfirm: async () => {},
  }}
/>
