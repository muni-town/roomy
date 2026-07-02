<script lang="ts">
  import ReactionBar, {
    type ReactionGroup,
    type ReactorInfo,
  } from "@roomy/design/components/content/thread/message/ReactionBar.svelte";
  import { addReaction, removeReaction } from "$lib/mutations/reaction";
  import { px } from "$lib/auth.svelte";
  import { resolveBlobUrl } from "$lib/utils";
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

  /** Map the DTO's `{emoji, count, myReactionId?}` into the `ReactionGroup[]` shape ReactionBar expects. */
  let reactionGroups = $derived<ReactionGroup[]>(
    reactions.map((r) => ({
      emoji: r.emoji,
      count: r.count,
      pressed: currentUserDid !== undefined && r.myReactionId !== undefined,
    })),
  );

  function onToggleReaction(emoji: string) {
    if (!currentUserDid) return;

    const group = reactions.find((r) => r.emoji === emoji);
    if (!group) {
      addReaction(spaceId, roomId, messageId, emoji);
      return;
    }

    if (!group.myReactionId) {
      addReaction(spaceId, roomId, messageId, emoji);
    } else {
      removeReaction(spaceId, roomId, group.myReactionId);
    }
  }

  /** Per-emoji tooltip open state, controlled after fetch completes. */
  let tooltipOpenByEmoji = $state<Record<string, boolean>>({});
  /** Per-emoji reactor data for tooltip rendering. */
  let tooltipReactorsByEmoji = $state<Record<string, ReactorInfo[]>>({});
  /** Track which emoji we've already fetched to avoid redundant calls. */
  let fetchedEmojis = $state<Set<string>>(new Set());

  async function onHover(emoji: string) {
    if (fetchedEmojis.has(emoji)) return;
    fetchedEmojis.add(emoji);
    // Open tooltip immediately with loading state.
    tooltipOpenByEmoji[emoji] = true;
    tooltipReactorsByEmoji[emoji] = [];
    try {
      const res = await px().query("space.roomy.message.getReactions", {
        messageId,
      });
      for (const group of res.reactions) {
        tooltipReactorsByEmoji[group.emoji] = group.reactors.map((r) => ({
          ...r,
          avatar: r.avatar ? resolveBlobUrl(r.avatar) : undefined,
        }));
      }
    } catch {
      tooltipReactorsByEmoji[emoji] = [];
    }
  }
</script>

<ReactionBar
  reactions={reactionGroups}
  {onToggleReaction}
  {onHover}
  {tooltipOpenByEmoji}
  {tooltipReactorsByEmoji}
/>
