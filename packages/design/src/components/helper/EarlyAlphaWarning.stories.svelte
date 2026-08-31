<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import EarlyAlphaWarning from "./EarlyAlphaWarning.svelte";

  const { Story } = defineMeta({
    title: "Helper/EarlyAlphaWarning",
    component: EarlyAlphaWarning,
  });
</script>

<Story name="Default" />
