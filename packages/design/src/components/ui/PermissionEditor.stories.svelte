<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import { type ComponentProps } from "svelte";
  import PermissionEditor from "./PermissionEditor.svelte";

  const { Story } = defineMeta({
    title: "UI/PermissionEditor",
    component: PermissionEditor,
    render: template,
  });
</script>

<Story
  name="Default"
  args={{
    defaultAccess: "readwrite",
    rolePermissions: {},
    roles: [
      { id: "role1", name: "Moderator" },
      { id: "role2", name: null },
    ],
    rolesLoading: false,
  }}
  {template}
/>

{#snippet template(args: ComponentProps<typeof PermissionEditor>)}
  <div class="p-4">
    <PermissionEditor {...args} />
  </div>
{/snippet}

<Story
  name="Loading"
  args={{ defaultAccess: "read", rolePermissions: {}, roles: null, rolesLoading: true }}
  {template}
/>
