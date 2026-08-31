<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import ToggleNavigation from "./ToggleNavigation.svelte";

  const { Story } = defineMeta({
    title: "Helper/ToggleNavigation",
    component: ToggleNavigation,
  });
</script>

{#snippet template(args: { isSidebarVisible: boolean })}
  <div class="p-4 flex items-center gap-3">
    <ToggleNavigation isSidebarVisible={args.isSidebarVisible} />
    <span class="text-sm text-base-500"
      >Sidebar visible: {args.isSidebarVisible ? "yes" : "no"}</span
    >
  </div>
{/snippet}

<Story
  name="Default"
  args={{ isSidebarVisible: true }}
  {template}
/>

<Story
  name="Hidden"
  args={{ isSidebarVisible: false }}
  {template}
/>
