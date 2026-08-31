<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import Error from "./Error.svelte";

  const { Story } = defineMeta({
    title: "Modals/Error",
    component: Error,
    parameters: { layout: "fullscreen" },
  });

  type Args = {
    message: string;
    goHome: boolean;
    tellUs: boolean;
  };
</script>

<Story
  name="Default"
  args={{ message: "Room not found", goHome: false, tellUs: true }}
/>

<Story name="GoHome" args={{ message: "Space not found", goHome: true, tellUs: true }} />
