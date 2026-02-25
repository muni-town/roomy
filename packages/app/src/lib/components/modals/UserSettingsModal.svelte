<script lang="ts">
  import { peer } from "$lib/workers";
  import { Modal, Heading } from "@foxui/core";
  import Button from "$lib/components/ui/button/Button.svelte";

  let {
    open = $bindable(false),
  }: {
    open: boolean;
  } = $props();
</script>

<Modal bind:open>
  <Heading>User Settings</Heading>
  <!-- <h2 class="text-lg font-bold">Recovery</h2>
  <p>
    Roomy is in alpha and occasionally there may be bugs where resetting the
    local database can fix the issue. This will clear your offline cache, but it
    will not actually delete any of your data off of the server.
  </p>
  <Button
    onclick={() => {
      peer
        .dangerousCompletelyDestroyDatabase({ yesIAmSure: true })
        .then((result) =>
          result.done
            ? window.location.reload()
            : console.error("Could not reset cache:", result.error),
        );
    }}>Reset Local Cache</Button
  > -->
  <h2 class="text-lg font-bold">Account</h2>
  <Button
    class="w-full justify-start"
    size="lg"
    onclick={() => {
      peer.logout().then(() => {
        open = false;
        window.location.reload();
      });
    }}
  >
    Log Out
  </Button>
</Modal>
