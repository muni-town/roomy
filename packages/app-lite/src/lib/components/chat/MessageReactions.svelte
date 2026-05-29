<script lang="ts">
  import ReactionBar, {
    type ReactionInfo,
  } from "@roomy/design/components/content/thread/message/ReactionBar.svelte";
  import { addReaction } from "$lib/mutations/reaction";
  import type { Message } from "$lib/queries/messages";

  type Props = {
    spaceId: string;
    roomId: string;
    messageId: string;
    reactions: Message["reactions"];
    currentUserDid?: string;
  };

  let { spaceId, roomId, messageId, reactions, currentUserDid }: Props =
    $props();

  /** Flatten the DTO's `{emoji, dids[]}` into the `ReactionInfo[]` shape ReactionBar expects. */
  let reactionInfos = $derived<ReactionInfo[]>(
    reactions.flatMap(({ emoji, dids }) =>
      dids.map(
        (did) =>
          ({
            reaction: emoji,
            userId: did,
            userName: did,
            reactionId: "",
          }) satisfies ReactionInfo,
      ),
    ),
  );

  function onToggleReaction(emoji: string) {
    if (!currentUserDid) return;

    // Find the DTO reaction group for this emoji
    const group = reactions.find((r) => r.emoji === emoji);
    if (!group) {
      // New reaction — add it
      addReaction(spaceId, roomId, messageId, emoji);
      return;
    }

    const alreadyReacted = group.dids.includes(currentUserDid);

    if (!alreadyReacted) {
      // User hasn't reacted — add
      addReaction(spaceId, roomId, messageId, emoji);
    } else {
      // Removal needs a reactionId the DTO does not yet carry.
      // Task 8 will fill this branch once the appserver surfaces myReactionId.
      return;
    }
  }
</script>

<ReactionBar
  reactions={reactionInfos}
  {currentUserDid}
  {onToggleReaction}
/>
