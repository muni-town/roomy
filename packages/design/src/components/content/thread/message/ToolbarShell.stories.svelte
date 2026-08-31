<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import ToolbarShell from "./ToolbarShell.svelte";

  const { Story } = defineMeta({
    title: "Content/Thread/Message/ToolbarShell",
    component: ToolbarShell,
  });
</script>

{#snippet template(args: { canEdit: boolean; canDelete: boolean; mergeWithPrevious: boolean; keepToolbarOpen: boolean })}
  <div class="w-full max-w-2xl p-4">
    <ToolbarShell
      canEdit={args.canEdit}
      canDelete={args.canDelete}
      mergeWithPrevious={args.mergeWithPrevious}
      keepToolbarOpen={args.keepToolbarOpen}
      onToggleReaction={() => {}}
      onEdit={() => {}}
      onDelete={() => {}}
      onStartThreading={() => {}}
      onReply={() => {}}
      onForward={() => {}}
    />
  </div>
{/snippet}

<Story
  name="Default"
  args={{
    canEdit: true,
    canDelete: true,
    mergeWithPrevious: false,
    keepToolbarOpen: false,
  }}
  {template}
/>

<Story
  name="AuthorOnly"
  args={{
    canEdit: true,
    canDelete: false,
    mergeWithPrevious: false,
    keepToolbarOpen: false,
  }}
  {template}
/>
