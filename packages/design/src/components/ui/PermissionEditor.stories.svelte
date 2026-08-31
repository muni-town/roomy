<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import PermissionEditor from "./PermissionEditor.svelte";

  const { Story } = defineMeta({
    title: "UI/PermissionEditor",
    component: PermissionEditor,
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
/>

{#snippet template(args)}
  <div class="p-4">
    <PermissionEditor {...(args as any)} />
  </div>
{/snippet}

<Story
  name="Loading"
  args={{ defaultAccess: "read", rolePermissions: {}, roles: null, rolesLoading: true }}
  {template}
/>
