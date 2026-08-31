<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import UserTypeaheadList from "./UserTypeaheadList.svelte";

  const { Story } = defineMeta({
    title: "UI/UserTypeaheadList",
    component: UserTypeaheadList,
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
    <UserTypeaheadList
      users={mockUsers}
      activeIndex={args.activeIndex}
      onSelect={noop}
      onHover={noop}
    />
  </div>
{/snippet}

<Story name="Default" args={{ activeIndex: 0 }} {template} />
