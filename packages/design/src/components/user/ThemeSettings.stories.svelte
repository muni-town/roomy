<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import ThemeSettings from "./ThemeSettings.svelte";

  const { Story } = defineMeta({
    title: "User/ThemeSettings",
    component: ThemeSettings,
  });
</script>

{#snippet template(_args)}
  <div class="p-4 w-full max-w-sm">
    <ThemeSettings />
  </div>
{/snippet}

<Story name="Default" {template} parameters={{ layout: "fullscreen" }} />
