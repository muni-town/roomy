<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import ErrorMessage from "./ErrorMessage.svelte";

  const { Story } = defineMeta({
    title: "Helper/ErrorMessage",
    component: ErrorMessage,
  });
</script>

<Story name="Default" args={{ message: "Something went wrong" }} />
