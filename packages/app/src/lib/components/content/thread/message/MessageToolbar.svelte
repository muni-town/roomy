<script lang="ts">
  import ToolbarShell from "@roomy/design/components/content/thread/message/ToolbarShell.svelte";
  import { messagingState } from "../TimelineView.svelte";
  import type { Message } from "../ChatArea.svelte";
  import { peerStatus } from "$lib/workers";
  import { getAppState } from "$lib/queries";
  import { addReaction, removeReaction } from "$lib/mutations/reaction";
  import { deleteMessage } from "$lib/mutations/message";

  const app = getAppState();

  let {
    editMessage,
    message,
    startThreading,
    keepToolbarOpen = $bindable(false),
  }: {
    canEdit?: boolean;
    editMessage: () => void;
    message: Message;
    startThreading: () => void;
    keepToolbarOpen: boolean;
  } = $props();

  let canEditAndDelete = $derived(
    !!peerStatus.authState &&
      peerStatus.authState.state === "authenticated" &&
      (app.isSpaceAdmin || message.authorDid == peerStatus.authState.did),
  );

  function onToggleReaction(emoji: string) {
    const spaceId = app.joinedSpace?.id;
    if (!spaceId || !app.roomId) return;

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
    if (!spaceId || !app.roomId) return;
    if (!canEditAndDelete) return;
    await deleteMessage(spaceId, app.roomId, message.id);
  }
</script>

<ToolbarShell
  canEditDelete={canEditAndDelete}
  bind:keepToolbarOpen
  {onToggleReaction}
  onEdit={editMessage}
  {onDelete}
  onStartThreading={startThreading}
  onReply={() => messagingState.setReplyTo(message)}
/>
