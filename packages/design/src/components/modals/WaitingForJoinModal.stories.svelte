<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import WaitingForJoinModal from "./WaitingForJoinModal.svelte";

  const { Story } = defineMeta({
    title: "Modals/WaitingForJoinModal",
    component: WaitingForJoinModal,
    parameters: { layout: "fullscreen" },
  });

</script>

<Story name="Default" args={{ open: true }} />
