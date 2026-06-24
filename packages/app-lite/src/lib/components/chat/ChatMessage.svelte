<script lang="ts">
  import { goto } from "$app/navigation";
  import { Checkbox } from "bits-ui";
  import MessageBubble from "@roomy/design/components/content/thread/message/MessageBubble.svelte";
  import { messagingState } from "./messaging-state.svelte";
  import { renderMarkdownSanitized } from "@roomy/design/utils";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import { IconCheck, IconX } from "@roomy/design/icons";
  import MessageContext from "./MessageContext.svelte";
  import MessageReactions from "./MessageReactions.svelte";
  import MessageToolbar from "./MessageToolbar.svelte";
  import MediaEmbed from "./embeds/MediaEmbed.svelte";
  import LinkCard from "./embeds/LinkCard.svelte";
  import ChatInput from "./ChatInput.svelte";
  import { editMessage } from "$lib/mutations/message";
  import type { Message } from "$lib/queries/messages";
  import { resolveBlobUrl } from "$lib/utils";

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
  // Local buffer for the in-place editor. Bound to ChatInput so the save
  // button can submit the current text. Re-seeded from the latest message
  // content when editing *begins*: a pre-effect runs before the DOM update,
  // so the fresh value is in place before ChatInput mounts and reads it.
  // Rising-edge only, so in-progress edits aren't clobbered if the server
  // pushes an updated message while editing.
  let editContent = $state("");
  let prevEditing = false;
  $effect.pre(() => {
    const editing = isEditing;
    if (editing && !prevEditing) {
      editContent = message.content;
    }
    prevEditing = editing;
  });
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
      authorHandle={message.authorHandle ?? undefined}
      authorAvatarUrl={message.authorAvatar ?? undefined}
      avatarSrc={resolveBlobUrl(message.authorAvatar)}
      profileUrl={`/user/${message.authorDid}`}
      onAvatarClick={() => goto(`/user/${message.authorDid}`)}
      timestamp={new Date(message.timestamp)}
      {isBridged}
      {mergeWithPrevious}
      {isSelected}
      {isEditing}
      {showToolbar}
    >
      {#snippet replyContext()}
        {#if message.replyTo}
          <MessageContext context={{ kind: "replying", replyTo: { id: message.replyTo } }} roomId={roomId} />
        {/if}
      {/snippet}

      {#snippet content()}
        {#if isEditing}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="editing-message"
            onkeydown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                onCancelEdit();
              }
            }}
          >
            <ChatInput
              bind:content={editContent}
              onEnter={handleEdit}
              placeholder="Edit message..."
              disabled={false}
              setFocus={true}
            />
          </div>
        {:else}
          {@html renderMarkdownSanitized(message.content)}
        {/if}
      {/snippet}

      {#snippet actions()}
        {#if isEditing}
          <Button
            variant="secondary"
            size="icon"
            class="shrink-0 rounded-full"
            aria-label="Cancel editing"
            title="Cancel (Esc)"
            onclick={onCancelEdit}
          >
            <IconX />
          </Button>
          <Button
            variant="primary"
            size="icon"
            class="shrink-0 rounded-full"
            aria-label="Save changes"
            title="Save (Enter)"
            onclick={() => handleEdit(editContent)}
          >
            <IconCheck />
          </Button>
        {/if}
      {/snippet}

      {#snippet linkEmbeds()}
        {#if message.linkEmbeds && message.linkEmbeds.length > 0}
          {@const withEmbed = message.linkEmbeds.filter((l) => l.embed)}
          {#if withEmbed.length > 0}
            <div class="flex flex-col gap-2 mt-1">
              {#each withEmbed as link (link.url)}
                <LinkCard url={link.url} embed={link.embed} />
              {/each}
            </div>
          {/if}
        {/if}
      {/snippet}

      {#snippet media()}
        {#if message.media && message.media.length > 0}
          {@const nonLinkMedia = message.media.filter((m) => !m.type.startsWith("text/"))}
          {#if nonLinkMedia.length > 0}
            <MediaEmbed media={nonLinkMedia.map((m) => ({ ...m, alt: m.alt ?? undefined }))} />
          {/if}
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

<style>
  /*
    The rendered message lives directly under the `.prose` wrapper, so Tailwind
    Typography's `.prose > :first-child { margin-top: 0 }` / `> :last-child
    { margin-bottom: 0 }` resets make its first/last paragraphs flush with the
    bubble. The tiptap editor instead renders paragraphs nested under
    `.tiptap` (inside `#chat-input`), so those resets never reach it and the
    editor picks up an extra ~1.25em margin above its first paragraph and below
    its last — making the edited content look inset vs. the rendered message.
    Mirror the resets here, scoped to the editing editor so the composer (which
    is not inside `.prose`) is unaffected.
  */
  :global(.editing-message .tiptap > :first-child) {
    margin-top: 0;
  }
  :global(.editing-message .tiptap > :last-child) {
    margin-bottom: 0;
  }
</style>
