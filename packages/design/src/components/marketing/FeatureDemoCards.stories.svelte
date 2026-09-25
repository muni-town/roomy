<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import FeatureDemoCards from "./FeatureDemoCards.svelte";

  const { Story } = defineMeta({
    title: "Marketing/FeatureDemoCards",
    component: FeatureDemoCards,
  });
</script>

<Story name="Default" />
