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
  <h2 class="text-lg font-bold">Recovery</h2>
  <p>
    Roomy is in alpha and occasionally there may be bugs where resetting the
    local database can fix the issue. This will clear your offline cache, but it
    will not actually delete any of your data off of the server.
  </p>
  <Button
    onclick={() => {
      backend
        .dangerousCompletelyDestroyDatabase({ yesIAmSure: true })
        .then(() => window.location.reload());
    }}>Reset Local Cache</Button
  >
  <h2 class="text-lg font-bold">Account</h2>
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
