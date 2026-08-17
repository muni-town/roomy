<script lang="ts">
  import ToolbarShell from "@roomy/design/components/content/thread/message/ToolbarShell.svelte";
  import { messagingState } from "./messaging-state.svelte";
  import { addReaction } from "$lib/mutations/reaction";
  import type { Message } from "$lib/queries/messages";

  type Props = {
    spaceId: string;
    roomId: string;
    message: Message;
    mergeWithPrevious?: boolean;
    canEdit: boolean;
    canDelete: boolean;
    keepToolbarOpen?: boolean;
    onStartEdit: (messageId: string) => void;
    /** Requests the delete confirmation (owned by ChatArea). */
    onRequestDelete: () => void;
  };

  let {
    spaceId,
    roomId,
    message,
    mergeWithPrevious = false,
    canEdit,
    canDelete,
    keepToolbarOpen = $bindable(false),
    onStartEdit,
    onRequestDelete,
  }: Props = $props();

  function onToggleReaction(emoji: string) {
    addReaction(spaceId, roomId, message.id, emoji);
  }

  function onReply() {
    messagingState.setReplyTo(message);
  }

  function onStartThreading() {
    messagingState.startThreading(message);
  }

  function onEdit() {
    onStartEdit(message.id);
  }

  function onDelete() {
    onRequestDelete();
  }
</script>

<ToolbarShell
  {canEdit}
  {canDelete}
  {mergeWithPrevious}
  bind:keepToolbarOpen
  {onToggleReaction}
  {onEdit}
  {onDelete}
  {onStartThreading}
  {onReply}
/>
