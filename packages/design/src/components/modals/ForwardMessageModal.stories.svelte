<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import ForwardMessageModal from "./ForwardMessageModal.svelte";

  const { Story } = defineMeta({
    title: "Modals/ForwardMessageModal",
    component: ForwardMessageModal,
  });

  type Args = {
    open: boolean;
    fetchState: {
      status: "idle" | "loading" | "error" | "success";
      data?: { id: string; name?: string }[];
      message?: string;
    };
  };
</script>

{#snippet template(args: Args)}
  <ForwardMessageModal
    {...(args as any)}
    onForward={async () => {
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
      data: [
        { id: "r1", name: "General" },
        { id: "r2", name: "Random" },
      ],
    },
  }}
  {template}
/>

<Story
  name="Empty"
  args={{
    open: true,
    fetchState: { status: "success", data: [] },
  }}
  {template}
/>

<Story
  name="Error"
  args={{
    open: true,
    fetchState: { status: "error", message: "Failed to load rooms" },
  }}
  {template}
/>
