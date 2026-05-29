<script lang="ts">
  import ReactionBar from "@roomy/design/components/content/thread/message/ReactionBar.svelte";
  import { getAppState } from "$lib/queries";
  import type { Message } from "../ChatArea.svelte";
  import { addReaction, removeReaction } from "$lib/mutations/reaction";

  const app = getAppState();

  let {
    message,
  }: {
    message: Message;
  } = $props();

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
</script>

<ReactionBar
  reactions={message.reactions}
  currentUserDid={app.did}
  {onToggleReaction}
/>
