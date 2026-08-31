<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import RoomEditForm from "./RoomEditForm.svelte";

  const { Story } = defineMeta({
    title: "Modals/RoomEditForm",
    component: RoomEditForm,
  });

  type Args = {
    open: boolean;
    kind: string;
    name: string;
    canDelete: boolean;
    deleteLabel: string;
    deleteConfirmTitle: string;
    deleteConfirmButton: string;
  };
</script>

{#snippet template(args: Args)}
  <RoomEditForm
    {...(args as any)}
    onSave={async () => {
      /* no-op in story */
    }}
    onDelete={async () => {
      /* no-op in story */
    }}
  >
    {#snippet deleteConfirmText()}
      <span>
        Archiving <b>General</b> hides it from non-admins. You can restore it
        later from the sidebar editor.
      </span>
    {/snippet}
  </RoomEditForm>
{/snippet}

<Story
  name="Default"
  args={{
    open: true,
    kind: "Channel",
    name: "General",
    canDelete: true,
    deleteLabel: "Archive channel",
    deleteConfirmTitle: "Archive?",
    deleteConfirmButton: "Archive",
  }}
  {template}
/>

<Story
  name="Simple"
  args={{
    open: true,
    kind: "Channel",
    name: "General",
    canDelete: false,
    deleteLabel: "Archive channel",
    deleteConfirmTitle: "Archive?",
    deleteConfirmButton: "Archive",
  }}
  {template}
/>
