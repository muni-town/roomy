<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import WelcomeActions from "./WelcomeActions.svelte";

  const { Story } = defineMeta({
    title: "Marketing/WelcomeActions",
    component: WelcomeActions,
  });
</script>

<Story name="Default" />
