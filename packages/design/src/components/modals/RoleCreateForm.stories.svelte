<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import RoleCreateForm from "./RoleCreateForm.svelte";

  const { Story } = defineMeta({
    title: "Modals/RoleCreateForm",
    component: RoleCreateForm,
  });

  type Args = {
    open: boolean;
    creating: boolean;
  };
</script>

{#snippet template(args: Args)}
  <RoleCreateForm
    {...(args as any)}
    onCreate={() => {
      /* no-op in story */
    }}
  />
{/snippet}

<Story name="Default" args={{ open: true, creating: false }} {template} />
