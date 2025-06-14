<script lang="ts">
  import { onMount } from 'svelte';
  import DMList from './DMList.svelte';
  import MessageList from './MessageList.svelte';
  import { dmClient } from '$lib/dm.svelte';
  import Icon from "@iconify/svelte";
  import Dialog from "$lib/components/Dialog.svelte";
  import { Button } from "bits-ui";
  
  export let initialConversationId: string | null = null;
  
  let selectedConversationId: string | null = initialConversationId;
  let showNewConversationDialog = false;
  let newConversationHandle = '';
  let isCreatingConversation = false;
  let error: string | null = null;
  let lastInitialConversationId: string | null = null;
  
  // Update selected conversation when initialConversationId changes
  $: {
    if (initialConversationId && initialConversationId !== lastInitialConversationId) {
      selectedConversationId = initialConversationId;
      lastInitialConversationId = initialConversationId;
    }
  }
  
  // Handle conversation selection from DMList
  function handleConversationSelected(conversationId: string) {
    selectedConversationId = conversationId;
    // Update the URL to reflect the selected conversation
    window.history.pushState({}, '', '/messages');
  }
  
  // Start a new conversation
  async function handleStartConversation(handle?: string) {
    const targetHandle = handle || newConversationHandle.trim();
    if (!targetHandle) return;
    
    isCreatingConversation = true;
    error = null;
    
    try {
      // Remove @ symbol if present
      const cleanHandle = targetHandle.startsWith('@') ? targetHandle.slice(1) : targetHandle;
      
      // Start a new conversation with an empty message
      const conversation = await dmClient.startConversation(cleanHandle, '');
      
      selectedConversationId = conversation.id;
      
      if (!handle) {
        // Only reset the dialog if this was triggered from the UI
        showNewConversationDialog = false;
        newConversationHandle = '';
      }
    } catch (err) {
      console.error('Failed to start conversation:', err);
      error = 'Failed to start conversation. Please check the handle and try again.';
      throw err; // Re-throw to allow parent component to handle the error
    } finally {
      isCreatingConversation = false;
    }
  }
</script>

<div class="flex h-full bg-base-100 overflow-hidden">
  <!-- Sidebar with conversation list -->
  <div class="w-80 min-w-80 max-w-80 border-r border-base-300 bg-base-200 flex flex-col h-full">
    <!-- Fixed header -->
    <div class="flex-shrink-0 p-4 border-b border-base-300">
      <div class="flex items-center justify-between">
        <h2 class="text-lg font-semibold text-base-content">Conversations</h2>
        <button
          onclick={() => showNewConversationDialog = true}
          class="dz-btn dz-btn-primary dz-btn-circle dz-btn-sm"
          title="New conversation"
          disabled={isCreatingConversation}
        >
          {#if isCreatingConversation}
            <span class="dz-loading dz-loading-spinner dz-loading-xs"></span>
          {:else}
            <Icon icon="tabler:plus" class="text-sm" />
          {/if}
        </button>
      </div>
    </div>
    
    <!-- Scrollable conversation list -->
    <div class="flex-1 min-h-0 overflow-hidden">
      <DMList 
        onConversationSelected={handleConversationSelected} 
        selectedConversationId={selectedConversationId}
      />
    </div>
  </div>
  
  <!-- Main content area for messages -->
  <div class="flex-1 flex flex-col bg-base-100 h-full overflow-hidden w-full">
    
    {#if isCreatingConversation && !selectedConversationId}
      <div class="flex items-center justify-center h-full">
        <div class="text-center p-6 max-w-md">
          <span class="dz-loading dz-loading-spinner dz-loading-lg text-primary"></span>
          <h3 class="mt-4 text-sm font-medium text-base-content">Starting conversation...</h3>
          <p class="mt-1 text-sm text-base-content/60">Please wait while we connect you.</p>
        </div>
      </div>
    {:else if selectedConversationId}
      <MessageList conversationId={selectedConversationId} />
    {:else}
      <div class="flex items-center justify-center h-full">
        <div class="text-center p-6 max-w-md">
          <Icon icon="tabler:message-circle" class="h-12 w-12 mx-auto text-base-content/40" />
          <h3 class="mt-2 text-sm font-medium text-base-content">No conversation selected</h3>
          <p class="mt-1 text-sm text-base-content/60">Select a conversation or start a new one to begin messaging.</p>
          <div class="mt-6">
            <button
              onclick={() => showNewConversationDialog = true}
              disabled={isCreatingConversation}
              class="dz-btn dz-btn-primary"
            >
              <Icon icon="tabler:plus" class="w-4 h-4" />
              New message
            </button>
          </div>
        </div>
      </div>
    {/if}
  </div>
  
  <!-- New Conversation Dialog -->
  <Dialog
    title="New Message"
    bind:isDialogOpen={showNewConversationDialog}
  >
    {#if error}
      <div class="dz-alert dz-alert-error mb-4">
        <Icon icon="tabler:alert-circle" />
        <span>{error}</span>
      </div>
    {/if}
    
    <form 
      id="newConversation"
      class="flex flex-col gap-4"
      onsubmit={handleStartConversation}
    >
      <label class="dz-input dz-input-bordered flex items-center gap-2">
        <Icon icon="tabler:at" class="w-4 h-4 opacity-70" />
        <input
          type="text"
          bind:value={newConversationHandle}
          placeholder="user.bsky.social"
          class="grow"
          disabled={isCreatingConversation}
          required
        />
      </label>
      
      <div class="flex justify-end gap-3">
        <Button.Root
          type="button"
          onclick={() => {
            showNewConversationDialog = false;
            error = null;
            newConversationHandle = '';
          }}
          class="dz-btn"
          disabled={isCreatingConversation}
        >
          Cancel
        </Button.Root>
        <Button.Root
          type="submit"
          class="dz-btn dz-btn-primary"
          disabled={!newConversationHandle.trim() || isCreatingConversation}
        >
          {#if isCreatingConversation}
            <span class="dz-loading dz-loading-spinner dz-loading-sm"></span>
            Starting...
          {:else}
            <Icon icon="tabler:send" class="w-4 h-4" />
            Start Conversation
          {/if}
        </Button.Root>
      </div>
    </form>
  </Dialog>
</div>

<style>
  :global(body) {
    @apply h-full;
  }
  
  :global(html) {
    @apply h-full;
  }
  
  :global(#app) {
    @apply h-full;
  }
</style>
