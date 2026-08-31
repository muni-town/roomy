<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import ThemeToggle from "./ThemeToggle.svelte";

  const { Story } = defineMeta({
    title: "UI/ThemeToggle",
    component: ThemeToggle,
  });
</script>

{#snippet template()}
  <div class="flex h-24 w-full items-center justify-center p-4">
    <ThemeToggle />
  </div>
{/snippet}

<Story name="Default" {template} />
