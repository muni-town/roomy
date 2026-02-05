<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { dmClient, type Message } from "$lib/dm.svelte";
  import { Button, ChatBubble, cn, Input } from "@fuxui/base";
  import { afterNavigate } from "$app/navigation";

  import "bluesky-post-embed";
  import "bluesky-post-embed/style.css";
  import "bluesky-post-embed/themes/light.css";

  import { IconAlertCircle, IconMessageCirclePlus, IconMessageCircle, IconSend } from "@roomy/design/icons";

  const { conversationId }: { conversationId: string } = $props();

  let messages: Message[] = $state([]);
  let isLoading = $state(true);
  let error: string | null = $state(null);
  let messageText = $state("");
  let isSending = $state(false);
  let messageEnd: HTMLElement | null = $state(null);
  let refreshInterval: NodeJS.Timeout | null = $state(null);
  let conversationPartner: {
    displayName?: string;
    handle?: string;
    did: string;
    avatar?: string;
  } | null = $state(null);
  let conversationStatus: string | null = $state(null);

  // $effect(() => {
  //   if (conversationId) {
  //     loadMessages();
  //     startMessageRefresh();
  //   }
  // });

  // Clean up interval on destroy
  onDestroy(() => {
    if (refreshInterval) {
      clearInterval(refreshInterval);
    }
  });

  onMount(() => {
    if (conversationId) {
      loadMessages();
      startMessageRefresh();
    }
  });

  afterNavigate(() => {
    if (conversationId) {
      refreshMessages();
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
        dmClient.getConversationDetails(conversationId),
      ]);

      messages = messagesResult;
      conversationStatus = conversationDetails.status ?? null;

      console.log("Conversation status:", conversationDetails);

      // Sort messages chronologically (oldest first)
      messages.sort(
        (a, b) => new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime(),
      );

      // Extract conversation partner info from messages
      if (messages.length > 0) {
        try {
          const currentUserDid = dmClient.getCurrentUserDid();
          console.log("Current user DID:", currentUserDid);
          console.log(
            "All message senders:",
            messages.map((m) => ({
              did: m.sender.did,
            })),
          );

          const otherUser = messages.find(
            (msg) => msg.sender.did !== currentUserDid,
          )?.sender;
          console.log("Found other user:", otherUser);

          if (otherUser) {
            // If we have the user but missing handle/displayName, fetch their profile
            try {
              const profile = await dmClient.getUserProfile(otherUser.did);
              conversationPartner = profile;
            } catch (err) {
              console.error("Failed to fetch user profile:", err);
              conversationPartner = otherUser;
            }
          }
        } catch (err) {
          console.error("Failed to get current user DID:", err);
        }
      }

      // Mark conversation as read with the latest message
      if (messages.length > 0) {
        const latestMessage = messages[messages.length - 1];
        if (latestMessage?.id)
          await dmClient.markAsRead(conversationId, latestMessage.id);
      }

      scrollToBottom();
    } catch (err) {
      console.error("Failed to load messages:", err);
      error = `Failed to load messages: ${err instanceof Error ? err.message : err}`;

      scrollToBottom();
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
      newMessages.sort(
        (a, b) => new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime(),
      );

      // Only update if we got new messages
      if (
        newMessages.length !== messages.length ||
        JSON.stringify(newMessages) !== JSON.stringify(messages)
      ) {
        const wasAtBottom = isScrolledToBottom();
        const hasNewMessages = newMessages.length > messages.length;
        messages = newMessages;

        // Mark as read if there are new messages and we have messages
        if (hasNewMessages && newMessages.length > 0) {
          const latestMessage = newMessages[newMessages.length - 1];
          if (latestMessage?.id)
            await dmClient.markAsRead(conversationId, latestMessage.id);
        }

        // Only auto-scroll if user was already at bottom
        if (wasAtBottom) {
          setTimeout(scrollToBottom, 100);
        }
      }
    } catch (err) {
      // Silently fail refresh - don't show error for background updates
      console.error("Failed to refresh messages:", err);
    }
  }

  // Check if user is scrolled to bottom
  function isScrolledToBottom(): boolean {
    if (!messageEnd) return true;
    const container = messageEnd.parentElement;
    if (!container) return true;

    return (
      container.scrollTop + container.clientHeight >=
      container.scrollHeight - 10
    );
  }

  async function handleSendMessage(event: Event) {
    event.preventDefault();
    if (!messageText.trim() || isSending) return;

    isSending = true;
    const text = messageText;
    messageText = "";

    try {
      await dmClient.sendMessage(conversationId, text);
      // Immediately refresh messages after sending
      await refreshMessages();
    } catch (err) {
      console.error("Failed to send message:", err);
      // Show error to user
      error = "Failed to send message. Please try again.";
      // Restore message
      messageText = text;
    } finally {
      isSending = false;
    }
  }

  function scrollToBottom() {
    if (messageEnd) {
      messageEnd.scrollIntoView({ behavior: "smooth" });
    }
  }

  $effect(() => {
    if (messages.length > 0) {
      setTimeout(scrollToBottom, 100);
    }
  });

  // Format message timestamp
  function formatTimestamp(timestamp: string): string {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  // Check if message is from current user
  function isCurrentUser(senderDid: string): boolean {
    return (
      senderDid === dmClient.getCurrentUserDid() || senderDid === "current-user"
    );
  }
  export function isOnlyEmojis(str: string): boolean {
    // 1. Remove all whitespace (spaces, tabs, newlines, etc.)
    const compact = str.replace(/\s+/g, "");

    // 2. If nothing left (or only whitespace), fail
    if (!compact) return false;

    // 3. Regex to match one “emoji sequence” (including ZWJ sequences & selectors)
    const emojiRegex =
      /\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?)*/gu;

    // 4. Extract all emoji sequences
    const matches = Array.from(compact.matchAll(emojiRegex), (m) => m[0]);

    // 5. If no matches, or joined matches ≠ the compact string, there were other characters
    if (matches.length === 0 || matches.join("") !== compact) {
      return false;
    }

    // 6. Finally ensure fewer than 5 emojis
    return matches.length < 5;
  }
</script>

<div class="flex flex-col h-full overflow-hidden">
  <!-- Conversation Header with Activity Heatmap -->

  {#if isLoading && messages.length === 0}
    <div class="flex-1 flex items-center justify-center">
      <span class="loading loading-spinner loading-lg text-primary"></span>
    </div>
  {:else if error}
    <div class="alert alert-error m-4 text-base-900 dark:text-base-100">
      <IconAlertCircle />
      <div>
        <div class="font-bold">Error</div>
        <div class="text-xs">{error}</div>
      </div>
      <Button onclick={loadMessages} variant="secondary">Retry</Button>
    </div>
  {:else}
    <!-- Show empty state for new conversations -->
    {#if messages.length === 0 && conversationStatus === "request"}
      <div class="flex-1 flex items-center justify-center p-6">
        <div class="text-center max-w-sm">
          <IconMessageCirclePlus
            class="h-12 w-12 mx-auto text-base-900 dark:text-base-100 mb-4"
          />
          <h3
            class="text-lg font-semibold text-base-900 dark:text-base-100 mb-2"
          >
            Start the conversation
          </h3>
          <p class="text-sm text-base-700 dark:text-base-300 mb-4">
            {#if conversationPartner}
              Send your first message to {conversationPartner.displayName ||
                conversationPartner.handle}
            {:else}
              This is the beginning of your conversation
            {/if}
          </p>
        </div>
      </div>
    {:else if messages.length === 0}
      <div class="flex-1 flex items-center justify-center p-6">
        <div class="text-center max-w-sm">
          <IconMessageCircle
            class="h-12 w-12 mx-auto text-base-content/40 mb-4"
          />
          <h3 class="text-lg font-semibold text-base-content mb-2">
            No messages yet
          </h3>
          <p class="text-sm text-base-content/60">
            Start typing below to begin the conversation
          </p>
        </div>
      </div>
    {:else}
      <div class="flex-1 min-h-0 overflow-y-auto px-4 pb-8 pt-4">
        {#key messages}
          {#each messages as message}
            {#if message.text}
              <div
                class={cn(
                  "text-xs text-base-700 dark:text-base-300 mt-2 mb-1 w-full",
                  isCurrentUser(message.sender.did)
                    ? "text-right"
                    : "text-left",
                )}
              >
                <time class="ml-1">{formatTimestamp(message.sentAt)}</time>
              </div>
              {#if !isOnlyEmojis(message.text)}
                <ChatBubble
                  side={isCurrentUser(message.sender.did) ? "right" : "left"}
                >
                  <div class="break-words max-w-full whitespace-pre-wrap">
                    {@html message.text.replace(/\n/g, "<br />")}
                  </div>
                  {#if message.embed && message.embed.type == "bluesky-post"}
                    <!-- TODO: use our own custom embed rendering? -->
                    <bluesky-post src={message.embed.atUri}></bluesky-post>
                  {/if}
                </ChatBubble>
              {:else}
                <div
                  class={cn(
                    "text-5xl w-full",
                    isCurrentUser(message.sender.did)
                      ? "text-right"
                      : "text-left",
                  )}
                >
                  {message.text}
                </div>
              {/if}
            {/if}
          {/each}
        {/key}
        <div bind:this={messageEnd}></div>
      </div>
    {/if}

    <div
      class="flex-none border-t border-base-400/30 dark:border-base-300/10 p-4"
    >
      <form onsubmit={handleSendMessage} class="flex gap-2">
        <Input
          type="text"
          bind:value={messageText}
          placeholder="Type a message..."
          class="flex-1"
          disabled={isSending}
        />
        <Button
          type="submit"
          variant="ghost"
          disabled={!messageText.trim() || isSending}
        >
          <IconSend />
        </Button>
      </form>
    </div>
  {/if}
</div>

<style>
  :global(.bluesky-embed) {
    --background-primary: var(--color-base-800);
    --text-secondary: var(--color-base-400);
    --text-primary: var(--color-base-200);
  }
</style>
