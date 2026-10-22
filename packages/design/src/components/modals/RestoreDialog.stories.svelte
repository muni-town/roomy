<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import { type ComponentProps } from "svelte";
  import RestoreDialog from "./RestoreDialog.svelte";

  const { Story } = defineMeta({
    title: "Modals/RestoreDialog",
    component: RestoreDialog,
    render: template,
  });

  type Args = ComponentProps<typeof RestoreDialog>;
</script>

{#snippet template(args: Args)}
  <RestoreDialog
    {...args}
    onRestore={() => {
      /* no-op in story */
    }}
  />
{/snippet}

<Story
  name="Default"
  args={{
    open: true,
    fetchState: {
      status: "success",
      data: [{ id: "r1", name: "Old Room" }],
    },
  }}
  {template}
/>

<Story
  name="Empty"
  args={{ open: true, fetchState: { status: "success", data: [] } }}
  {template}
/>
