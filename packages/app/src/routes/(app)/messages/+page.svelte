<script lang="ts">
  import { dmClient } from "$lib/dm.svelte";
  import { user } from "$lib/user.svelte";
  import DMContainer from "$lib/components/dm/DMContainer.svelte";
  import { goto } from "$app/navigation";
  import { toast } from "svelte-french-toast";
  import Icon from "@iconify/svelte";
  import { page } from "$app/state";

  let isInitialized = $state(false);
  let error = $state<string | null>(null);
  let selectedConversationId = $state<string | null>(null);

  // Reactively initialize DM client when user authentication is available
  $effect(async () => {
    if (user.agent && user.session && !isInitialized && !error) {
      try {
        const initialized = await dmClient.init();

        if (!initialized) {
          error = "Please log in to use direct messaging.";
          return;
        }

        isInitialized = true;

        // Check for conversation ID or user handle in URL
        const urlParams = new URLSearchParams(window.location.search);
        const conversationId = urlParams.get("conversation");
        const userHandle = urlParams.get("user");

        if (conversationId) {
          // Direct conversation link
          selectedConversationId = conversationId;
          // Clean up URL
          window.history.replaceState({}, "", "/messages");
        } else if (userHandle) {
          // Legacy user handle link
          try {
            await startNewConversation(userHandle);
          } catch (err) {
            console.error("Failed to start conversation:", err);
            error = "Failed to start conversation. Please try again.";
          }
        }
      } catch (err) {
        console.error("Failed to initialize DM client:", err);
        if (err instanceof Error) {
          if (
            err.message.includes("No active session") ||
            err.message.includes("not authenticated")
          ) {
            error = "Please log in to use direct messaging.";
          } else if (
            err.message.includes("Failed to fetch") ||
            err.message.includes("network")
          ) {
            error =
              "Unable to connect to the server. Please check your internet connection.";
          } else {
            error = "Failed to initialize messaging. Please try again later.";
          }
        } else {
          error = "An unexpected error occurred. Please try again.";
        }
      }
    }
  });

  // Find or create conversation with a user and select it
  async function startNewConversation(handle: string) {
    if (!handle) return;

    try {
      // Remove @ symbol if present
      const cleanHandle = handle.startsWith("@") ? handle.slice(1) : handle;

      // Find existing conversation or create new one
      const conversationId = await dmClient.findOrCreateConversation(cleanHandle);

      // Update the URL to remove the user parameter
      window.history.replaceState({}, "", "/messages");

      // Select the conversation
      selectedConversationId = conversationId;
    } catch (err) {
      console.error("Failed to find or start conversation:", err);
      toast.error(`Failed to open conversation with ${handle}`);
    }
  }

  // Handle navigation back to home
  function handleBack() {
    goto("/home");
  }
</script>

<div class="h-full w-full flex-1 flex flex-col bg-base-100">
  <!-- Header -->
  <div
    class="border-b border-base-300 bg-base-200 px-4 py-3 sm:px-6 lg:px-8 lg:hidden"
  >
    <div class="flex items-center">
      <button
        onclick={handleBack}
        class="mr-3 dz-btn dz-btn-ghost dz-btn-circle dz-btn-sm"
        aria-label="Back"
      >
        <Icon icon="tabler:arrow-left" class="text-lg" />
      </button>
      <h1 class="text-lg font-semibold text-base-content">Messages</h1>
    </div>
  </div>

  <!-- Main content -->
  <div class="flex-1 overflow-hidden">
    {#if !isInitialized && !error}
      <div class="flex items-center justify-center h-full">
        <div class="text-center">
          <span class="dz-loading dz-loading-spinner dz-loading-lg text-primary"
          ></span>
          <p class="mt-2 text-sm text-base-content/60">Loading messages...</p>
        </div>
      </div>
    {:else if error}
      <div class="flex items-center justify-center h-full">
        <div class="text-center p-6 max-w-md">
          <div class="text-error mb-4">
            <Icon icon="tabler:alert-triangle" class="h-12 w-12 mx-auto" />
          </div>
          <h3 class="text-lg font-medium text-base-content">
            Error loading messages
          </h3>
          <p class="mt-2 text-sm text-base-content/60">{error}</p>
          <button
            onclick={() => window.location.reload()}
            class="mt-4 dz-btn dz-btn-primary"
          >
            Try again
          </button>
        </div>
      </div>
    {:else}
      <DMContainer initialConversationId={selectedConversationId} />
    {/if}
  </div>
</div>
