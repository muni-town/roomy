<script lang="ts">
  import { page } from "$app/state";
  import { dmClient } from "$lib/dm.svelte";
  import type { ConvoView } from "@atproto/api/dist/client/types/chat/bsky/convo/defs";
  import { Avatar } from "@fuxui/base";

  let conversationDetails: ConvoView | null = $state(null);

  $effect(() => {
    if (
      page.params.id &&
      (!conversationDetails || conversationDetails?.id !== page.params.id)
    ) {
      conversationDetails = null;

      dmClient.getConversationDetails(page.params.id).then((details) => {
        conversationDetails = details;
      });
    }
  });

  function getConversationNames(participants: ConvoView["members"]) {
    const myDid = dmClient.getCurrentUserDid();
    const participantsWithoutMe = participants.filter((p) => p.did !== myDid);

    const participantNames = participantsWithoutMe
      .slice(0, 2)
      .map((p) => p.displayName || p.handle);
    let names = participantNames.join(", ");

    if (participantsWithoutMe.length > 2) {
      names += ` + ${participantsWithoutMe.length - 2} more`;
    }

    if (participantsWithoutMe.length === 0) {
      return "You";
    }

    return names;
  }

  function getConversationAvatar(participants: ConvoView["members"]) {
    const myDid = dmClient.getCurrentUserDid();
    const participantsWithoutMe = participants.filter((p) => p.did !== myDid);
    return participantsWithoutMe[0]?.avatar;
  }
</script>

{#if conversationDetails}
  <div class="flex flex-col items-center justify-between w-full px-2">
    <h2
      class="text-lg font-bold w-full py-4 text-base-900 dark:text-base-100 flex items-center gap-2"
    >
      <Avatar
        src={getConversationAvatar(conversationDetails?.members)}
        class="w-8 h-8"
      />
      {getConversationNames(conversationDetails?.members)}
    </h2>
  </div>
{/if}
