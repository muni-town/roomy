<script lang="ts">
  import { backend } from "$lib/workers";
  import { Modal, Button, Heading } from "@fuxui/base";

  let {
    open = $bindable(false),
  }: {
    open: boolean;
  } = $props();
</script>

<Modal bind:open>
  <Heading>User Settings</Heading>
  <Button
    class="w-full justify-start"
    size="lg"
    onclick={() => {
      backend.logout();
      open = false;
    }}
  >
    Log Out
  </Button>
</Modal>
