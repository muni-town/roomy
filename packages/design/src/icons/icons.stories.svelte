<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import * as icons from "./index";

  const { Story } = defineMeta({
    title: "Icons/Showcase",
  });
</script>

{#snippet template()}
  <div class="grid grid-cols-4 gap-4 p-6 sm:grid-cols-6 md:grid-cols-8">
    {#each Object.entries(icons) as [name, Icon]}
      <div
        class="flex flex-col items-center gap-2 rounded-xl border border-base-300/50 p-3"
      >
        <Icon class="size-6 text-base-700" />
        <span class="text-xs text-base-500">{name}</span>
      </div>
    {/each}
  </div>
{/snippet}

<Story name="All" {template} />
