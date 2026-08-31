<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import Drawer from "./Drawer.svelte";

  const { Story } = defineMeta({
    title: "Helper/Drawer",
    component: Drawer,
  });
</script>

{#snippet template(args: { title: string; description: string; open: boolean })}
  <Drawer
    title={args.title}
    description={args.description}
    open={args.open}
    onOpenChange={() => {}}
  >
    {#snippet children()}
      <p class="text-sm text-base-700 dark:text-base-300">
        This drawer content is provided via the children snippet. It slides up
        from the bottom of the viewport.
      </p>
    {/snippet}
  </Drawer>
{/snippet}

<Story
  name="Default"
  args={{ title: "Drawer", description: "A slide-up panel", open: true }}
  {template}
/>

<Story
  name="Closed"
  args={{ title: "Drawer", description: "A slide-up panel", open: false }}
  {template}
/>
