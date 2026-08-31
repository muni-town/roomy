<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import ToggleTabs from "./ToggleTabs.svelte";

  const { Story } = defineMeta({
    title: "Layout/ToggleTabs",
    component: ToggleTabs,
    parameters: { layout: "fullscreen" },
  });

  type Args = {
    items: { name: string; href: string; badge?: number }[];
    active: string;
  };
</script>

{#snippet template(args: Args)}
  <div class="p-4">
    <ToggleTabs {...(args as any)} />
  </div>
{/snippet}

<Story
  name="Default"
  args={{
    items: [
      { name: "Overview", href: "#/overview", badge: 3 },
      { name: "Events", href: "#/events" },
      { name: "Index", href: "#/index", badge: 120 },
    ],
    active: "Overview",
  }}
  {template}
/>
