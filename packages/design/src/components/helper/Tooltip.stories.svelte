<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import Tooltip from "./Tooltip.svelte";

  const { Story } = defineMeta({
    title: "Helper/Tooltip",
    component: Tooltip,
  });
</script>

{#snippet template(args: { tip: string; side: string })}
  <div class="p-16">
    <Tooltip tip={args.tip} side={(args.side as "top") || "top"}>
      {#snippet children()}
        <span
          class="inline-block border border-base-300 dark:border-base-600 rounded px-3 py-1 text-sm cursor-default"
          >Hover me</span
        >
      {/snippet}
    </Tooltip>
  </div>
{/snippet}

<Story name="Default" args={{ tip: "Tooltip text", side: "top" }} {template} />

<Story name="Bottom" args={{ tip: "Tooltip text", side: "bottom" }} {template} />
