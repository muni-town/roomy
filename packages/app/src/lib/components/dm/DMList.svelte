<script lang="ts">
  import { onMount } from 'svelte';
  import { dmClient } from '$lib/dm.svelte';
  import Icon from "@iconify/svelte";
  
  // Props
  let { 
    onConversationSelected,
    selectedConversationId 
  }: { 
    onConversationSelected?: (conversationId: string) => void;
    selectedConversationId?: string | null;
  } = $props();
  
  // State for conversations and loading state
  let conversations = $state([]);
  let isLoading = $state(true);
  let error = $state(null);
  
  // Load conversations when component mounts
  onMount(async () => {
    try {
      await dmClient.init();
      conversations = await dmClient.getConversations();
    } catch (err) {
      console.error('Failed to load conversations:', err);
      error = `Failed to load conversations: ${err.message || err}`;
      
      // For testing purposes, let's add some mock conversations
      conversations = [
        {
          id: 'mock-1',
          participants: [{did: 'did:plc:mock1', handle: 'alice.bsky.social', displayName: 'Alice'}],
          lastMessage: {text: 'Hey there!', sentAt: new Date().toISOString()},
          unreadCount: 2
        },
        {
          id: 'mock-2', 
          participants: [{did: 'did:plc:mock2', handle: 'bob.bsky.social', displayName: 'Bob'}],
          lastMessage: {text: 'How are you doing?', sentAt: new Date().toISOString()},
          unreadCount: 0
        },
        {
          id: 'mock-3',
          participants: [{did: 'did:plc:mock3', handle: 'charlie.bsky.social', displayName: 'Charlie'}],
          lastMessage: {text: 'See you later!', sentAt: new Date().toISOString()},
          unreadCount: 1
        }
      ];
    } finally {
      isLoading = false;
    }
  });
  
  // Handle conversation selection
  function selectConversation(conversationId: string) {
    // Call parent callback
    if (onConversationSelected) {
      onConversationSelected(conversationId);
    }
  }
</script>

{#if isLoading}
  <div class="text-center py-4">
    <span class="loading loading-spinner loading-md text-primary"></span>
    <p class="mt-2 text-sm text-base-content/60">Loading conversations...</p>
  </div>
{:else if error}
  <div class="alert alert-error m-4">
    <Icon icon="tabler:alert-circle" />
    <div>
      <div class="font-bold">Error</div>
      <div class="text-xs">{error}</div>
    </div>
    <button 
      onclick={() => window.location.reload()}
      class="btn btn-sm btn-outline"
    >
      Try again
    </button>
  </div>
{:else if conversations.length === 0}
  <div class="text-center py-8">
    <Icon icon="tabler:message-circle-off" class="h-8 w-8 mx-auto text-base-content/40 mb-2" />
    <p class="text-base-content/60">No conversations yet</p>
    <button 
      onclick={() => {
        conversations = [{
          id: 'test-1',
          participants: [{did: 'test', handle: 'test.bsky.social', displayName: 'Test User'}],
          lastMessage: {text: 'Test message', sentAt: new Date().toISOString()},
          unreadCount: 1
        }];
      }}
      class="btn btn-sm btn-primary mt-2"
    >
      Add Test Conversation
    </button>
  </div>
{:else}
  {#each conversations as conversation}
    <button 
      class="flex items-start justify-between w-full p-3 text-left transition-colors relative border-0 bg-transparent
             {selectedConversationId === conversation.id 
               ? 'bg-primary/10 border-r-2 border-primary text-primary' 
               : 'hover:bg-base-200 text-base-content'}"
      onclick={() => selectConversation(conversation.id)}
    >
      <div class="min-w-0 flex-1 pr-2">
        <div class="text-sm font-medium truncate w-full
                   {selectedConversationId === conversation.id ? 'text-primary' : 'text-base-content'}">
          {#if conversation.participants.length === 1}
            {conversation.participants[0].displayName || conversation.participants[0].handle}
          {:else if conversation.participants.length === 2}
            {conversation.participants[0].displayName || conversation.participants[0].handle}, {conversation.participants[1].displayName || conversation.participants[1].handle}
          {:else}
            {conversation.participants[0].displayName || conversation.participants[0].handle}, {conversation.participants[1].displayName || conversation.participants[1].handle}, +{conversation.participants.length - 2} more
          {/if}
        </div>
        {#if conversation.lastMessage}
          <p class="text-sm truncate mt-1 w-full
                   {selectedConversationId === conversation.id ? 'text-primary/70' : 'text-base-content/60'}">
            {conversation.lastMessage.text}
          </p>
        {/if}
      </div>
      {#if conversation.unreadCount > 0}
        <div class="badge badge-primary badge-sm flex-shrink-0">
          {conversation.unreadCount}
        </div>
      {/if}
    </button>
  {/each}
{/if}

