<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import CreateRoomModal from "./CreateRoomModal.svelte";

  const { Story } = defineMeta({
    title: "Modals/CreateRoomModal",
    component: CreateRoomModal,
  });

  type Args = {
    open: boolean;
    spaceId: string;
    defaultType: "Channel" | "Category";
  };
</script>

{#snippet template(args: Args)}
  <CreateRoomModal
    {...(args as any)}
    onCreate={async () => {
      /* no-op in story */
    }}
  />
{/snippet}

<Story
  name="Channel"
  args={{ open: true, spaceId: "did:plc:test", defaultType: "Channel" }}
  {template}
/>

<Story
  name="Category"
  args={{ open: true, spaceId: "did:plc:test", defaultType: "Category" }}
  {template}
/>
