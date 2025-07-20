<script lang="ts">
  import { Modal, Heading } from "@fuxui/base";

  let {
    open = $bindable(false),
  }: {
    open: boolean;
  } = $props();
</script>

<Modal bind:open>
  <Heading
    >Please wait a second while we prove you're not a robot by letting your
    computer do some math</Heading
  >
</Modal>
