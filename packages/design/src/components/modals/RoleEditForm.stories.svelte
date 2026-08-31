<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import RoleEditForm from "./RoleEditForm.svelte";

  const { Story } = defineMeta({
    title: "Modals/RoleEditForm",
    component: RoleEditForm,
  });

  type Args = {
    open: boolean;
    role: { id: string; name?: string; description?: string } | null;
    saving: boolean;
  };
</script>

{#snippet template(args: Args)}
  <RoleEditForm
    {...(args as any)}
    onSave={() => {
      /* no-op in story */
    }}
  />
{/snippet}

<Story
  name="Default"
  args={{
    open: true,
    role: { id: "role1", name: "Moderator", description: "Keeps things civil" },
    saving: false,
  }}
  {template}
/>
