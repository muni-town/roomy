<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import RoomPickerModal from "./RoomPickerModal.svelte";

  const { Story } = defineMeta({
    title: "Modals/RoomPickerModal",
    component: RoomPickerModal,
  });

  type Args = {
    open: boolean;
    mode: "forward" | "move";
    fetchState: {
      status: "idle" | "loading" | "error" | "success";
      data?: { id: string; name?: string }[];
      message?: string;
    };
  };
</script>

{#snippet template(args: Args)}
  <RoomPickerModal
    {...(args as any)}
    onSelect={async () => {
      /* no-op in story */
    }}
  />
{/snippet}

<Story
  name="Default"
  args={{
    open: true,
    mode: "forward",
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
  name="Move"
  args={{
    open: true,
    mode: "move",
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
  name="LongRoomName"
  args={{
    open: true,
    mode: "forward",
    fetchState: {
      status: "success",
      data: [
        {
          id: "r1",
          name: "A very long room name that would otherwise widen the modal past its maximum width and overflow horizontally",
        },
        { id: "r2", name: "Short" },
      ],
    },
  }}
  {template}
/>

<Story
  name="Empty"
  args={{
    open: true,
    mode: "forward",
    fetchState: { status: "success", data: [] },
  }}
  {template}
/>

<Story
  name="Error"
  args={{
    open: true,
    mode: "forward",
    fetchState: { status: "error", message: "Failed to load rooms" },
  }}
  {template}
/>
