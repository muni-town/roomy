<script lang="ts">
  import { page } from "$app/state";
  import { useTopicSubscription } from "@roomy-space/sdk/svelte";
  import type { Topic } from "@roomy-space/sdk/svelte";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import Input from "@roomy/design/components/ui/input/Input.svelte";
  import { sync_ } from "$lib/sync.svelte";
  import { createRoomMetadataQuery } from "$lib/queries/room-metadata";
  import { createMessagesQuery, type Message } from "$lib/queries/messages";
  import { sendMessage } from "$lib/mutations/message";
  import { updateSeen } from "$lib/mutations/update-seen";

  const spaceId = $derived(page.params.space!);
  const roomId = $derived(page.params.room!);

  let draft = $state("");
  let sending = $state(false);
  let sendError = $state<string | null>(null);

  useTopicSubscription(
    () => sync_.ctx?.topicManager ?? null,
    () => [{ kind: "room", id: roomId } satisfies Topic],
  );

  $effect(() => {
    sync_.setActiveRoom(roomId);
    updateSeen(roomId).catch(() => {});
    return () => {
      if (sync_.activeRoomId === roomId) sync_.setActiveRoom(null);
    };
  });

  const roomQuery = createRoomMetadataQuery(() => roomId);
  const messagesQuery = createMessagesQuery(() => roomId);

  async function onSend() {
    const text = draft.trim();
    if (!text || sending) return;
    sending = true;
    sendError = null;
    try {
      await sendMessage(spaceId, roomId, text);
      draft = "";
    } catch (err) {
      sendError = err instanceof Error ? err.message : String(err);
    } finally {
      sending = false;
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  }
</script>

<div class="h-full flex flex-col">
  <!-- Room header -->
  {#if roomQuery.isPending}
    <div class="px-4 py-2 border-b border-base-200 dark:border-base-800 text-sm text-base-400">Loading room…</div>
  {:else if roomQuery.isError}
    <div class="px-4 py-2 border-b border-base-200 dark:border-base-800 text-sm text-red-600">{roomQuery.error.message}</div>
  {:else if roomQuery.data}
    {@const room = roomQuery.data}
    <header class="px-4 py-2 border-b border-base-200 dark:border-base-800 bg-white dark:bg-base-900 flex items-center justify-between shrink-0">
      <div>
        <h2 class="font-semibold">{room.name}</h2>
        <span class="text-xs text-base-400">{room.kind} · {room.canWrite ? "can write" : "read only"}</span>
      </div>
      {#if room.unreadCount > 0}
        <span class="text-xs bg-accent-100 dark:bg-accent-900/30 text-accent-700 dark:text-accent-400 px-2 py-0.5 rounded-full">
          {room.unreadCount} unread
        </span>
      {/if}
    </header>
  {/if}

  <!-- Messages -->
  <div class="flex-1 overflow-y-auto px-4 py-3 space-y-2">
    {#if messagesQuery.isPending}
      <p class="text-center text-sm text-base-400 py-8">Loading messages…</p>
    {:else if messagesQuery.isError}
      <p class="text-center text-sm text-red-600 py-8">{messagesQuery.error.message}</p>
    {:else if messagesQuery.data}
      {#if messagesQuery.data.length === 0}
        <p class="text-center text-sm text-base-400 py-8">No messages yet</p>
      {/if}
      {#each messagesQuery.data as message (message.id)}
        {@render messageBubble(message)}
      {/each}
    {/if}
  </div>

  <!-- Input -->
  <div class="px-4 py-3 border-t border-base-200 dark:border-base-800 bg-white dark:bg-base-900 shrink-0">
    {#if sendError}
      <p class="text-xs text-red-600 mb-1">{sendError}</p>
    {/if}
    {#if roomQuery.data && !roomQuery.data.canWrite}
      <p class="text-xs text-base-400 italic">You don't have permission to send messages here.</p>
    {:else}
      <div class="flex gap-2">
        <Input
          placeholder="Send a message…"
          bind:value={draft}
          onkeydown={onKeydown}
          disabled={sending}
        />
        <Button onclick={onSend} disabled={sending || !draft.trim()}>Send</Button>
      </div>
    {/if}
  </div>
</div>

{#snippet messageBubble(message: Message)}
  <div class="flex gap-2.5 group">
    <div class="w-8 h-8 rounded-full bg-base-200 dark:bg-base-700 shrink-0 flex items-center justify-center text-xs font-bold text-base-500">
      {(message.authorName || "?")[0]?.toUpperCase() ?? "?"}
    </div>
    <div class="flex-1 min-w-0">
      <div class="flex items-baseline gap-2">
        <span class="font-medium text-sm">{message.authorName || message.authorDid.slice(0, 12)}</span>
        <span class="text-[11px] text-base-400">
          {new Date(message.timestamp).toLocaleTimeString("en", { hour12: false, hour: "2-digit", minute: "2-digit" })}
        </span>
      </div>
      <p class="text-sm whitespace-pre-wrap break-words">{message.content}</p>
      {#if message.reactions.length > 0}
        <div class="flex gap-1 mt-1">
          {#each message.reactions as reaction}
            <span class="text-xs bg-base-100 dark:bg-base-800 px-1.5 py-0.5 rounded-full">
              {reaction.emoji} {reaction.dids.length}
            </span>
          {/each}
        </div>
      {/if}
    </div>
  </div>
{/snippet}
