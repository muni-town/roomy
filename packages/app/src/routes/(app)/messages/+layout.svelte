<script lang="ts">
  import { dmClient } from "$lib/dm.svelte";
  import { page } from "$app/state";
  import MainLayout, {
    isSidebarVisible,
  } from "$lib/components/layout/MainLayout.svelte";
  import ConversationsList from "$lib/components/dm/ConversationsList.svelte";
  import MessageList from "$lib/components/dm/MessageList.svelte";
  import { Button } from "@fuxui/base";
  import NewMessageModal from "$lib/components/modals/NewMessageModal.svelte";
  import { onMount } from "svelte";
  import ConversationNavbar from "$lib/components/dm/ConversationNavbar.svelte";

  let { children } = $props();

  let isInitialized = $state(false);
  let error = $state<string | null>(null);

  // Reactively initialize DM client when user authentication is available
  $effect(() => {
    if (user.agent && user.session && !isInitialized && !error) {
      try {
        const initialized = dmClient.init();

        if (!initialized) {
          error = "Please log in to use direct messaging.";
          return;
        }

        isInitialized = true;
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

  let showNewMessageModal = $state(false);

  onMount(() => {
    if (!page.params.id) {
      isSidebarVisible.value = true;
    }
  });
</script>

<MainLayout>
  {#snippet sidebar()}
    <div class="flex flex-col items-center justify-between w-full px-2">
      <h2
        class="text-lg font-bold w-full py-4 text-base-900 dark:text-base-100"
      >
        Conversations
      </h2>

      {#if isInitialized && !error}
        <!-- Scrollable conversation list -->
        <div
          class="relative overflow-y-auto h-full text-base-900 w-full space-y-2 pb-8"
        >
          <Button
            class="w-full mb-4"
            onclick={() => (showNewMessageModal = true)}
          >
            <Icon icon="tabler:plus" class="w-4 h-4" />
            Start new
          </Button>

          <ConversationsList selectedConversationId={page.params.id} />
        </div>
      {/if}
    </div>
  {/snippet}

  {#snippet navbar()}
    <ConversationNavbar />
  {/snippet}

  <div class="flex-1 overflow-hidden">
    {#if !isInitialized && !error}
      <div class="flex items-center justify-center h-full">
        <div class="text-center">
          <p class="mt-2 text-sm text-base-700 dark:text-base-300">
            Loading messages...
          </p>
        </div>
      </div>
    {:else if error}
      <div
        class="flex items-center justify-center h-full text-base-700 dark:text-base-300"
      >
        <div class="text-center p-6 max-w-md">
          <div class="text-error mb-4">
            <Icon icon="tabler:alert-triangle" class="h-12 w-12 mx-auto" />
          </div>
          <h3 class="text-lg font-medium">Error loading messages</h3>
          <p class="mt-2 text-sm text-accent-600 dark:text-accent-400">
            {error}
          </p>
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
    {:else}
      <div class="h-full w-full flex items-center justify-center">
        <div class="text-center">
          <p class="mt-2 text-sm text-base-700 dark:text-base-300">
            Select an existing conversation or start a new one
          </p>

          <Button
            class="mt-4 dz-btn dz-btn-primary"
            onclick={() => (showNewMessageModal = true)}
          >
            Start new
          </Button>
        </div>
      </div>
    {/if}
  </div>
</MainLayout>

<!--
  Note: We are actually handling all rendering the layout and not actually worrying about
  rendering the page. This is here merely to prevent a warning from Svelte.
-->
{@render children()}

<NewMessageModal bind:open={showNewMessageModal} />
