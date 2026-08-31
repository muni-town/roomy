<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import WaitingForJoinModal from "./WaitingForJoinModal.svelte";

  const { Story } = defineMeta({
    title: "Modals/WaitingForJoinModal",
    component: WaitingForJoinModal,
    parameters: { layout: "fullscreen" },
  });

  type Args = {
    open: boolean;
  };
</script>

<Story name="Default" args={{ open: true }} />
