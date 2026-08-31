<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import RestoreDialog from "./RestoreDialog.svelte";

  const { Story } = defineMeta({
    title: "Modals/RestoreDialog",
    component: RestoreDialog,
  });

  type Args = {
    open: boolean;
    fetchState: {
      status: "idle" | "loading" | "error" | "success";
      data?: { id: string; name?: string | null }[];
      message?: string;
    };
  };
</script>

{#snippet template(args: Args)}
  <RestoreDialog
    {...(args as any)}
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
