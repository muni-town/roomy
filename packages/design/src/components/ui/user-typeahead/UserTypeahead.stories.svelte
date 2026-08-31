<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import UserTypeahead from "./UserTypeahead.svelte";

  const { Story } = defineMeta({
    title: "UI/UserTypeahead",
    component: UserTypeahead,
  });

  const mockUsers = [
    { did: "did:plc:1", handle: "ada", name: "Ada Lovelace" },
    { did: "did:plc:2", handle: "alan", name: "Alan Turing" },
    { did: "did:plc:3", handle: "grace", name: "Grace Hopper" },
    { did: "did:plc:4", handle: "ken", name: "Ken Thompson" },
  ];

  function noop() {}
</script>

{#snippet template(args)}
  <div class="p-4">
    <UserTypeahead
      users={mockUsers}
      onSelect={noop}
      placeholder={args.placeholder}
      excluded={args.excluded}
    />
  </div>
{/snippet}

<Story
  name="Default"
  args={{ placeholder: "Search members…", excluded: [] }}
  {template}
/>
<Story
  name="WithExcluded"
  args={{ placeholder: "Search members…", excluded: ["did:plc:1"] }}
  {template}
/>
