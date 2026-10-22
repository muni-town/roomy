<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import { type ComponentProps } from "svelte";
  import ThemeSettings from "./ThemeSettings.svelte";

  const { Story } = defineMeta({
    title: "User/ThemeSettings",
    component: ThemeSettings,
    render: template,
  });
</script>

{#snippet template(_args: ComponentProps<typeof ThemeSettings>)}
  <div class="p-4 w-full max-w-sm">
    <ThemeSettings />
  </div>
{/snippet}

<Story name="Default" {template} parameters={{ layout: "fullscreen" }} />
