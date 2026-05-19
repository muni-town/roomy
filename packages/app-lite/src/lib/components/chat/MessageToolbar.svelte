<script lang="ts">
  import ToolbarShell from "@roomy/design/components/content/thread/message/ToolbarShell.svelte";
  import { messagingState } from "./messaging-state.svelte";
  import { addReaction } from "$lib/mutations/reaction";
  import { deleteMessage } from "$lib/mutations/message";
  import type { Message } from "$lib/queries/messages";

  type Props = {
    spaceId: string;
    roomId: string;
    message: Message;
    canEditDelete: boolean;
    keepToolbarOpen?: boolean;
    onStartEdit: (messageId: string) => void;
  };

  let {
    spaceId,
    roomId,
    message,
    canEditDelete,
    keepToolbarOpen = $bindable(false),
    onStartEdit,
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

  async function onDelete() {
    if (!confirm("Delete this message?")) return;
    await deleteMessage(spaceId, roomId, message.id);
  }
</script>

<ToolbarShell
  {canEditDelete}
  bind:keepToolbarOpen
  {onToggleReaction}
  {onEdit}
  {onDelete}
  {onStartThreading}
  {onReply}
/>
