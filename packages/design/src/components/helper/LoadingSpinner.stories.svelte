<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import LoadingSpinner from "./LoadingSpinner.svelte";

  const { Story } = defineMeta({
    title: "Helper/LoadingSpinner",
    component: LoadingSpinner,
  });
</script>

<Story name="Default" args={{ size: 40 }} />

<Story name="Large" args={{ size: 64 }} />
