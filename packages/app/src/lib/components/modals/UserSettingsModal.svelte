<script lang="ts">
  import { user } from "$lib/user.svelte";
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
      user.logout();
      open = false;
    }}
  >
    Log Out
  </Button>
</Modal>
