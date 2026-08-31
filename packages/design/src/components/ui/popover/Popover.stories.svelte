<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import Popover from "./Popover.svelte";

  const { Story } = defineMeta({
    title: "UI/Popover",
    component: Popover,
  });
</script>

{#snippet template(args)}
  <div class="flex h-96 w-full items-center justify-center p-4">
    <Popover triggerText={args.triggerText} side={args.side}>
      {#snippet children()}
        <p>This popover content appears next to the trigger.</p>
      {/snippet}
    </Popover>
  </div>
{/snippet}

<Story
  name="Default"
  args={{ triggerText: "Open popover", side: "top" }}
  {template}
/>
