<script lang="ts">
  import MessageDrawer from "@roomy/design/components/content/thread/message/MessageDrawer.svelte";
  import { messagingState } from "../TimelineView.svelte";
  import type { Message } from "../ChatArea.svelte";
  import { peerStatus } from "$lib/workers";
  import { getAppState } from "$lib/queries";
  import { addReaction, removeReaction } from "$lib/mutations/reaction";
  import { deleteMessage } from "$lib/mutations/message";

  const app = getAppState();

  let {
    message,
    open = $bindable(false),
    onStartThreading,
    onEditMessage,
  }: {
    message: Message | null;
    open: boolean;
    onStartThreading: () => void;
    onEditMessage: () => void;
  } = $props();

  let canEditAndDelete = $derived(
    !!message &&
      !!peerStatus.authState &&
      peerStatus.authState.state === "authenticated" &&
      (app.isSpaceAdmin || message.authorDid == peerStatus.authState.did),
  );

  function onToggleReaction(emoji: string) {
    const spaceId = app.joinedSpace?.id;
    if (!spaceId || !app.roomId || !message) return;

    const reaction = message.reactions.find(
      (x) => x.userId == app.did && x.reaction == emoji,
    );

    if (!reaction) {
      addReaction(spaceId, app.roomId, message.id, emoji);
    } else {
      removeReaction(spaceId, app.roomId, reaction.reactionId);
    }
  }

  async function onDelete() {
    const spaceId = app.joinedSpace?.id;
    if (!spaceId || !app.roomId || !message) return;
    if (!canEditAndDelete) return;
    await deleteMessage(spaceId, app.roomId, message.id);
  }
</script>

<MessageDrawer
  visible={message !== null}
  bind:open
  canEditDelete={canEditAndDelete}
  {onToggleReaction}
  onReply={() => message && messagingState.setReplyTo(message)}
  {onStartThreading}
  onEdit={onEditMessage}
  {onDelete}
/>
