<script lang="ts">
  import { networkStatus, attemptReconnect, checkSyncServerConnection } from "$lib/network-status.svelte";
  import { onMount, onDestroy } from "svelte";
  import Icon from "@iconify/svelte";
  import toast from "svelte-french-toast";
  import { Button } from "bits-ui";
  import { g } from "$lib/global.svelte";

  // Check connection periodically
  let intervalId: number;

  onMount(() => {
    // Check connection status every 30 seconds
    intervalId = window.setInterval(() => {
      checkSyncServerConnection();
    }, 30000);
  });

  onDestroy(() => {
    if (intervalId) {
      window.clearInterval(intervalId);
    }
  });

  async function handleReconnect() {
    const success = await attemptReconnect();

    if (success) {
      toast.success("Reconnected to sync server", { position: "bottom-end" });

      // Reinitialize Roomy if we have a global instance
      if (g.roomy) {
        try {
          // Force a commit to test the connection
          g.roomy.commit();
          console.log("Forced commit to test connection");
        } catch (error) {
          console.error("Error during reconnection commit:", error);
        }
      }
    } else {
      toast.error("Failed to reconnect. Please try again later.", { position: "bottom-end" });
    }
  }
</script>

{#if !networkStatus.isOnline || !networkStatus.syncServerReachable}
  <div class="fixed bottom-4 right-4 z-50 bg-error text-error-content p-3 rounded-lg shadow-lg flex items-center gap-2">
    <Icon icon="mdi:sync-off" class="text-xl" />
    <div class="flex flex-col">
      <span class="font-bold">Sync Issue Detected</span>
      <span class="text-sm">
        {#if !networkStatus.isOnline}
          You appear to be offline
        {:else if !networkStatus.syncServerReachable}
          Cannot reach sync server
        {/if}
      </span>
      {#if networkStatus.lastSyncAttempt}
        <span class="text-xs opacity-80">Last check: {networkStatus.lastSyncAttempt.toLocaleTimeString()}</span>
      {/if}
    </div>
    <Button.Root
      onclick={handleReconnect}
      class="btn btn-sm btn-outline border-error-content text-error-content ml-2"
    >
      <Icon icon="mdi:refresh" class="mr-1" />
      Reconnect
    </Button.Root>
  </div>
{/if}

