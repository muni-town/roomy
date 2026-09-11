<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import Toggle from "./Toggle.svelte";

  const { Story } = defineMeta({
    title: "UI/Toggle",
    component: Toggle,
  });
</script>

{#snippet template()}
  <div class="flex h-24 w-full items-center justify-center p-4">
    <Toggle />
  </div>
{/snippet}

<Story name="Default" {template} />
