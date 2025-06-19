<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { dmClient } from '$lib/dm.svelte';
  import Icon from "@iconify/svelte";
  import DMProfileHeader from './DMProfileHeader.svelte';
  
  export let conversationId: string;
  
  let messages = [];
  let isLoading = true;
  let error: string | null = null;
  let messageText = '';
  let isSending = false;
  let messageEnd: HTMLElement;
  let refreshInterval: number;
  let conversationPartner: { displayName?: string; handle: string; did: string; avatar?: string } | null = null;
  let conversationStatus: string | null = null;
  
  // Load messages when conversationId changes
  $: if (conversationId) {
    loadMessages();
    startMessageRefresh();
  }
  
  // Clean up interval on destroy
  onDestroy(() => {
    if (refreshInterval) {
      clearInterval(refreshInterval);
    }
  });
  
  async function loadMessages() {
    if (!conversationId) return;
    
    isLoading = true;
    error = null;
    
    try {
      // Load conversation details and messages in parallel
      const [messagesResult, conversationDetails] = await Promise.all([
        dmClient.getMessages(conversationId),
        dmClient.getConversationDetails(conversationId)
      ]);
      
      messages = messagesResult;
      conversationStatus = conversationDetails.status;
      
      // Sort messages chronologically (oldest first)
      messages.sort((a, b) => new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime());
      
      // Extract conversation partner info from messages
      if (messages.length > 0) {
        try {
          const currentUserDid = dmClient.getCurrentUserDid();
          console.log('Current user DID:', currentUserDid);
          console.log('All message senders:', messages.map(m => ({ did: m.sender.did, handle: m.sender.handle })));
          
          const otherUser = messages.find(msg => msg.sender.did !== currentUserDid)?.sender;
          console.log('Found other user:', otherUser);
          
          if (otherUser) {
            // If we have the user but missing handle/displayName, fetch their profile
            if (!otherUser.handle) {
              try {
                const profile = await dmClient.getUserProfile(otherUser.did);
                conversationPartner = profile;
              } catch (err) {
                console.error('Failed to fetch user profile:', err);
                conversationPartner = otherUser;
              }
            } else {
              conversationPartner = otherUser;
            }
          } else {
            // If no other user found, this might be a conversation with yourself or all messages are from current user
            // In that case, take any sender that has proper info
            const anySender = messages.find(msg => msg.sender.handle)?.sender;
            if (anySender) {
              conversationPartner = anySender;
            }
          }
        } catch (err) {
          console.error('Failed to get current user DID:', err);
          // Fallback: use the first sender with a handle
          const firstSender = messages.find(msg => msg.sender.handle)?.sender;
          if (firstSender) {
            conversationPartner = firstSender;
          }
        }
      }
      
      // Mark conversation as read with the latest message
      if (messages.length > 0) {
        const latestMessage = messages[messages.length - 1];
        try {
          await dmClient.markAsRead(conversationId, latestMessage.id);
        } catch (readError) {
          console.error('Failed to mark conversation as read:', readError);
        }
      }
      
      scrollToBottom();
    } catch (err) {
      console.error('Failed to load messages:', err);
      error = `Failed to load messages: ${err.message || err}`;
      
      // Add mock messages for testing
      if (conversationId.startsWith('mock-')) {
        messages = [
          {
            id: 'msg-1',
            text: 'Hello! This is a test message.',
            sender: {
              did: 'did:plc:mock1',
              handle: 'alice.bsky.social',
              displayName: 'Alice'
            },
            sentAt: new Date(Date.now() - 3600000).toISOString() // 1 hour ago
          },
          {
            id: 'msg-2', 
            text: 'Hey there! How are you?',
            sender: {
              did: 'current-user',
              handle: 'me.bsky.social',
              displayName: 'Me'
            },
            sentAt: new Date(Date.now() - 1800000).toISOString() // 30 min ago
          },
          {
            id: 'msg-3',
            text: 'I\'m doing great, thanks for asking!',
            sender: {
              did: 'did:plc:mock1',
              handle: 'alice.bsky.social', 
              displayName: 'Alice'
            },
            sentAt: new Date(Date.now() - 900000).toISOString() // 15 min ago
          }
        ];
        // Sort mock messages chronologically too
        messages.sort((a, b) => new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime());
        scrollToBottom();
      }
    } finally {
      isLoading = false;
    }
  }
  
  // Start periodic message refresh
  function startMessageRefresh() {
    // Clear existing interval if any
    if (refreshInterval) {
      clearInterval(refreshInterval);
    }
    
    // Refresh messages every 3 seconds
    refreshInterval = setInterval(() => {
      if (conversationId && !isLoading && !isSending) {
        refreshMessages();
      }
    }, 3000);
  }
  
  // Refresh messages without showing loading spinner
  async function refreshMessages() {
    if (!conversationId) return;
    
    try {
      const newMessages = await dmClient.getMessages(conversationId);
      // Sort messages chronologically (oldest first)
      newMessages.sort((a, b) => new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime());
      
      // Only update if we got new messages
      if (newMessages.length !== messages.length || 
          JSON.stringify(newMessages) !== JSON.stringify(messages)) {
        const wasAtBottom = isScrolledToBottom();
        const hasNewMessages = newMessages.length > messages.length;
        messages = newMessages;
        
        // Mark as read if there are new messages and we have messages
        if (hasNewMessages && newMessages.length > 0) {
          const latestMessage = newMessages[newMessages.length - 1];
          try {
            await dmClient.markAsRead(conversationId, latestMessage.id);
          } catch (readError) {
            console.error('Failed to mark new messages as read:', readError);
          }
        }
        
        // Only auto-scroll if user was already at bottom
        if (wasAtBottom) {
          setTimeout(scrollToBottom, 100);
        }
      }
    } catch (err) {
      // Silently fail refresh - don't show error for background updates
      console.error('Failed to refresh messages:', err);
    }
  }
  
  // Check if user is scrolled to bottom
  function isScrolledToBottom(): boolean {
    if (!messageEnd) return true;
    const container = messageEnd.parentElement;
    if (!container) return true;
    
    return container.scrollTop + container.clientHeight >= container.scrollHeight - 10;
  }
  
  async function handleSendMessage(event: Event) {
    event.preventDefault();
    if (!messageText.trim() || isSending) return;
    
    isSending = true;
    const text = messageText;
    messageText = '';
    
    try {
      await dmClient.sendMessage(conversationId, text);
      // Immediately refresh messages after sending
      await refreshMessages();
    } catch (err) {
      console.error('Failed to send message:', err);
      // Show error to user
      error = 'Failed to send message. Please try again.';
      // Restore message
      messageText = text;
    } finally {
      isSending = false;
    }
  }
  
  function scrollToBottom() {
    if (messageEnd) {
      messageEnd.scrollIntoView({ behavior: 'smooth' });
    }
  }
  
  // Auto-scroll when new messages arrive
  $: if (messages.length > 0) {
    // Use setTimeout to ensure the DOM has updated
    setTimeout(scrollToBottom, 100);
  }
  
  // Format message timestamp
  function formatTimestamp(timestamp: string): string {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  
  // Check if message is from current user
  function isCurrentUser(senderDid: string): boolean {
    try {
      return senderDid === dmClient.getCurrentUserDid() || senderDid === 'current-user';
    } catch {
      // If we can't get current user DID, treat as other user
      return senderDid === 'current-user';
    }
  }
</script>

<div class="flex flex-col h-full bg-base-100 overflow-hidden">
  <!-- Conversation Header with Activity Heatmap -->
  <DMProfileHeader {conversationPartner} />

  {#if isLoading && messages.length === 0}
    <div class="flex-1 flex items-center justify-center">
      <span class="loading loading-spinner loading-lg text-primary"></span>
    </div>
  {:else if error}
    <div class="alert alert-error m-4">
      <Icon icon="tabler:alert-circle" />
      <div>
        <div class="font-bold">Error</div>
        <div class="text-xs">{error}</div>
      </div>
      <button 
        onclick={loadMessages}
        class="btn btn-sm btn-outline"
      >
        Retry
      </button>
    </div>
  {:else}
    <!-- Show empty state for new conversations -->
    {#if messages.length === 0 && conversationStatus === 'request'}
      <div class="flex-1 flex items-center justify-center p-6">
        <div class="text-center max-w-sm">
          <Icon icon="tabler:message-circle-plus" class="h-12 w-12 mx-auto text-primary mb-4" />
          <h3 class="text-lg font-semibold text-base-content mb-2">Start the conversation</h3>
          <p class="text-sm text-base-content/60 mb-4">
            {#if conversationPartner}
              Send your first message to {conversationPartner.displayName || conversationPartner.handle}
            {:else}
              This is the beginning of your conversation
            {/if}
          </p>
        </div>
      </div>
    {:else if messages.length === 0}
      <div class="flex-1 flex items-center justify-center p-6">
        <div class="text-center max-w-sm">
          <Icon icon="tabler:message-circle" class="h-12 w-12 mx-auto text-base-content/40 mb-4" />
          <h3 class="text-lg font-semibold text-base-content mb-2">No messages yet</h3>
          <p class="text-sm text-base-content/60">Start typing below to begin the conversation</p>
        </div>
      </div>
    {:else}
      <div class="flex-1 min-h-0 overflow-y-auto px-4 space-y-4">
        {#each messages as message}
        <div class="chat {isCurrentUser(message.sender.did) ? 'chat-end' : 'chat-start'}">
          <div class="chat-header text-xs opacity-50">
            {message.sender.displayName || message.sender.handle}
            <time class="ml-1">{formatTimestamp(message.sentAt)}</time>
          </div>
          <div class="chat-bubble {isCurrentUser(message.sender.did) ? 'chat-bubble-primary' : 'chat-bubble-secondary'} prose max-w-none">
            {message.text}
          </div>
        </div>
        {/each}
        <div bind:this={messageEnd}></div>
      </div>
    {/if}
    
    <div class="flex-none border-t border-base-400/30 dark:border-base-300/10 p-4">
      <form 
        onsubmit={handleSendMessage}
        class="flex gap-2"
      >
        <input
          type="text"
          bind:value={messageText}
          placeholder="Type a message..."
          class="input input-bordered flex-1"
          disabled={isSending}
        />
        <button
          type="submit"
          class="btn btn-primary btn-square"
          disabled={!messageText.trim() || isSending}
        >
          {#if isSending}
            <span class="loading loading-spinner loading-sm"></span>
          {:else}
            <Icon icon="tabler:send" class="w-4 h-4" />
          {/if}
        </button>
      </form>
    </div>
  {/if}
</div>
