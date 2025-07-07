<script lang="ts">
  import { dmClient } from "$lib/dm.svelte";
  import { user } from "$lib/user.svelte";
  import DMContainer from "$lib/components/dm/DMContainer.svelte";
  import { goto } from "$app/navigation";
  import { toast } from "svelte-french-toast";
  import Icon from "@iconify/svelte";
  import { page } from "$app/state";
  import MainLayout from "$lib/components/layout/MainLayout.svelte";
  import DMList from "$lib/components/dm/DMList.svelte";
  import MessageList from "$lib/components/dm/MessageList.svelte";

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
      const conversationId =
        await dmClient.findOrCreateConversation(cleanHandle);

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

<MainLayout>
  {#snippet sidebar()}
    <div class="flex flex-col items-center justify-between w-full px-2">
      <h2 class="text-lg font-bold w-full py-4 text-base-900 dark:text-base-100">Conversations</h2>

      {#if isInitialized && !error}
        <!-- Scrollable conversation list -->
        <div class="relative overflow-y-auto h-full text-base-900 w-full">
          <DMList
            onConversationSelected={(id) => {
              console.log("conversation selected");
            }}
            selectedConversationId={page.params.id}
          />
        </div>
      {/if}
    </div>
  {/snippet}

  <div class="flex-1 overflow-hidden">
    {#if !isInitialized && !error}
      <div class="flex items-center justify-center h-full">
        <div class="text-center">
          <p class="mt-2 text-sm text-base-700 dark:text-base-300">Loading messages...</p>
        </div>
      </div>
    {:else if error}
      <div class="flex items-center justify-center h-full text-base-700 dark:text-base-300">
        <div class="text-center p-6 max-w-md">
          <div class="text-error mb-4">
            <Icon icon="tabler:alert-triangle" class="h-12 w-12 mx-auto" />
          </div>
          <h3 class="text-lg font-medium">
            Error loading messages
          </h3>
          <p class="mt-2 text-sm text-accent-600 dark:text-accent-400">{error}</p>
          <button
            onclick={() => window.location.reload()}
            class="mt-4 dz-btn dz-btn-primary"
          >
            Try again
          </button>
        </div>
      </div>
    {:else if page.params.id}
      <MessageList conversationId={page.params.id} />
    {/if}
  </div>
</MainLayout>
