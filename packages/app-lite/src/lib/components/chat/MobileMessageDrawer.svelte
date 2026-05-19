<script lang="ts">
  import MessageDrawerShell from "@roomy/design/components/content/thread/message/MessageDrawer.svelte";
  import { messagingState } from "./messaging-state.svelte";
  import { addReaction } from "$lib/mutations/reaction";
  import { deleteMessage } from "$lib/mutations/message";
  import type { Message } from "$lib/queries/messages";

  type Props = {
    spaceId: string;
    roomId: string;
    message: Message | null;
    open?: boolean;
    canEditDelete: boolean;
    onStartEdit: (messageId: string) => void;
  };

  let {
    spaceId,
    roomId,
    message,
    open = $bindable(false),
    canEditDelete,
    onStartEdit,
  }: Props = $props();

  let visible = $derived(message !== null);

  function onToggleReaction(emoji: string) {
    if (!message) return;
    addReaction(spaceId, roomId, message.id, emoji);
  }

  function onReply() {
    if (!message) return;
    messagingState.setReplyTo(message);
  }

  function onStartThreading() {
    if (!message) return;
    messagingState.startThreading(message);
  }

  function onEdit() {
    if (!message) return;
    onStartEdit(message.id);
  }

  async function onDelete() {
    if (!message) return;
    if (!confirm("Delete this message?")) return;
    await deleteMessage(spaceId, roomId, message.id);
  }
</script>

<MessageDrawerShell
  {visible}
  bind:open
  {canEditDelete}
  {onToggleReaction}
  {onReply}
  {onStartThreading}
  {onEdit}
  {onDelete}
/>
