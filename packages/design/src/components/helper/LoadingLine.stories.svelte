<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import LoadingLine from "./LoadingLine.svelte";

  const { Story } = defineMeta({
    title: "Helper/LoadingLine",
    component: LoadingLine,
  });
</script>

<Story name="Default" />
