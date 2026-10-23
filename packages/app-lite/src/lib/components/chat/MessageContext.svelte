<script lang="ts">
  import { getContext } from "svelte";
  import MessageContextShell, {
    type MessageContext,
  } from "@roomy/design/components/content/thread/message/MessageContext.svelte";
  import MessageContextReply from "./MessageContextReply.svelte";
  import { messageContentToPlaintext } from "./messagePreview";

  type Props = {
    context: MessageContext;
    roomId: string;
  };

  let { context, roomId }: Props = $props();

  const scrollToMessage = getContext<(id: string) => void>("scrollToMessage");

  const firstThreadMessage = $derived(
    context.kind === "threading" ? context.selectedMessages[0] : undefined,
  );
</script>

<MessageContextShell {context} onScrollToMessage={scrollToMessage}>
  {#snippet replyPreview()}
    {#if context.kind === "replying"}
      <MessageContextReply replyToId={context.replyTo.id} {roomId} />
    {/if}
  {/snippet}
  {#snippet threadPreview()}
    {@html messageContentToPlaintext(
      firstThreadMessage?.content ?? "",
      firstThreadMessage?.mimeType,
    )}
  {/snippet}
</MessageContextShell>
