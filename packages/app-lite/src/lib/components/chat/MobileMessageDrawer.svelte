<script lang="ts">
  import MessageDrawerShell from "@roomy/design/components/content/thread/message/MessageDrawer.svelte";
  import { messagingState } from "./messaging-state.svelte";
  import { addReaction } from "$lib/mutations/reaction";
  import type { Message } from "$lib/queries/messages";

  type Props = {
    spaceId: string;
    roomId: string;
    message: Message | null;
    open?: boolean;
    canEdit: boolean;
    canDelete: boolean;
    onForward: (message: Message) => void;
    onStartEdit: (messageId: string) => void;
    /** Requests the delete confirmation (owned by ChatArea). */
    onRequestDelete: () => void;
  };

  let {
    spaceId,
    roomId,
    message,
    open = $bindable(false),
    canEdit,
    canDelete,
    onForward,
    onStartEdit,
    onRequestDelete,
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

  function onDelete() {
    onRequestDelete();
  }
</script>

<MessageDrawerShell
  {visible}
  bind:open
  {canEdit}
  {canDelete}
  {onToggleReaction}
  {onReply}
  onForward={() => message && onForward(message)}
  {onStartThreading}
  {onEdit}
  {onDelete}
/>
