<script lang="ts">
  import { Checkbox } from "bits-ui";
  import MessageBubble from "@roomy/design/components/content/thread/message/MessageBubble.svelte";
  import { messagingState } from "./messaging-state.svelte";
  import { renderMarkdownSanitized } from "@roomy/design/utils";
  import MessageContext from "./MessageContext.svelte";
  import MessageReactions from "./MessageReactions.svelte";
  import MessageToolbar from "./MessageToolbar.svelte";
  import MediaEmbed from "./embeds/MediaEmbed.svelte";
  import ChatInput from "./ChatInput.svelte";
  import { editMessage } from "$lib/mutations/message";
  import type { Message } from "$lib/queries/messages";

  type Props = {
    spaceId: string;
    roomId: string;
    message: Message;
    currentUserDid: string | undefined;
    editingMessageId: string | undefined;
    onStartEdit: (messageId: string) => void;
    onCancelEdit: () => void;
    onOpenMobileMenu: (message: Message) => void;
    mergeWithPrevious?: boolean;
  };

  let {
    spaceId,
    roomId,
    message,
    currentUserDid,
    editingMessageId,
    onStartEdit,
    onCancelEdit,
    onOpenMobileMenu,
    mergeWithPrevious = false,
  }: Props = $props();

  let hovered = $state(false);
  let keepToolbarOpen = $state(false);
  let isEditing = $derived(editingMessageId === message.id);
  let isThreading = $derived(messagingState.current.kind === "threading");
  let isSelected = $derived(
    isThreading && messagingState.current.selectedMessages.some((m) => m.id === message.id),
  );
  let showToolbar = $derived(
    (!isEditing && hovered && !isThreading) || keepToolbarOpen,
  );
  let isBridged = $derived(message.authorDid.startsWith("did:discord:"));
  let canEditDelete = $derived(message.authorDid === currentUserDid);

  function handleContextAction(e: MouseEvent) {
    // On mobile (coarse pointer), long-press opens the drawer
    if (matchMedia("(pointer: coarse)").matches) {
      e.preventDefault();
      onOpenMobileMenu(message);
    }
  }

  function resolveAvatarUrl(uri: string | null | undefined): string | undefined {
    if (!uri) return undefined;
    if (uri.startsWith("atblob://")) {
      const split = uri.split("atblob://")[1]?.split("/");
      if (!split || split.length !== 2) return undefined;
      const [did, cid] = split;
      return `https://cdn.bsky.app/img/feed_fullsize/plain/${did}/${cid}`;
    }
    return uri;
  }

  async function handleEdit(newContent: string) {
    if (newContent === message.content) {
      onCancelEdit();
      return;
    }
    await editMessage(spaceId, roomId, message.id, newContent);
    onCancelEdit();
  }
</script>

{#snippet messageBox()}
  <div
    class="relative"
    onmouseenter={() => (hovered = true)}
    onmouseleave={() => (hovered = false)}
    oncontextmenu={handleContextAction}
  >
    <MessageBubble
      authorDid={message.authorDid}
      authorName={message.authorName ?? undefined}
      authorHandle={undefined}
      authorAvatarUrl={message.authorAvatar ?? undefined}
      avatarSrc={resolveAvatarUrl(message.authorAvatar)}
      timestamp={new Date(message.timestamp)}
      {isBridged}
      {mergeWithPrevious}
      {isSelected}
      {showToolbar}
    >
      {#snippet replyContext()}
        {#if message.replyTo}
          <MessageContext context={{ kind: "replying", replyTo: { id: message.replyTo } }} roomId={roomId} />
        {/if}
      {/snippet}

      {#snippet content()}
        {#if isEditing}
          <ChatInput
            content={message.content}
            onEnter={handleEdit}
            placeholder="Edit message..."
            disabled={false}
          />
          <button onclick={onCancelEdit} class="text-xs text-base-400 mt-1 hover:underline">Cancel</button>
        {:else}
          {@html renderMarkdownSanitized(message.content)}
        {/if}
      {/snippet}

      {#snippet media()}
        {#if message.media && message.media.length > 0}
          <MediaEmbed media={message.media.map((m) => ({ ...m, alt: m.alt ?? undefined }))} />
        {/if}
      {/snippet}

      {#snippet toolbar()}
        <MessageToolbar
          {spaceId}
          {roomId}
          {message}
          {canEditDelete}
          bind:keepToolbarOpen
          {onStartEdit}
        />
      {/snippet}

      {#snippet reactions()}
        {#if message.reactions.length > 0}
          <MessageReactions
            {spaceId}
            {roomId}
            messageId={message.id}
            reactions={message.reactions}
            currentUserDid={currentUserDid}
          />
        {/if}
      {/snippet}
    </MessageBubble>
  </div>
{/snippet}

{#if isThreading}
  <Checkbox.Root
    aria-label="Select message"
    onclick={(e) => e.stopPropagation()}
    bind:checked={
      () => isSelected,
      () => messagingState.toggleMessageSelection(message)
    }
    class="flex flex-col w-full relative max-w-full isolate px-4 select-none"
  >
    {@render messageBox()}
  </Checkbox.Root>
{:else}
  <div class="flex flex-col w-full relative max-w-full isolate px-4">
    {@render messageBox()}
  </div>
{/if}
