<script lang="ts">
  import ChatMessage from "./ChatMessage.svelte";
  import { Announcement, Message, type Timeline } from "@roomy-chat/sdk";
  import { derivePromise } from "$lib/utils.svelte";
  import VirtualScroll from "./VirtualScroll.svelte";
  import LinkPreview from "./LinkPreview.svelte";
  import { g } from "$lib/global.svelte";

  let {
    timeline,
  }: {
    timeline: Timeline;
  } = $props();

  const messages = derivePromise([], async () =>
    (await timeline.timeline.items())
      .map((x) => x.tryCast(Message) || x.tryCast(Announcement))
      .filter((x) => !!x),
  );

  function shouldMergeWithPrevious(
    message: Message | Announcement,
    previousMessage?: Message | Announcement,
  ): boolean {
    const areMessages =
      previousMessage instanceof Message &&
      message instanceof Message &&
      !previousMessage.softDeleted;
    const authorsAreSame =
      areMessages &&
      message.authors((x) => x.get(0)) ==
        previousMessage.authors((x) => x.get(0));
    const messagesWithin5Minutes =
      (message.createdDate?.getTime() || 0) -
        (previousMessage?.createdDate?.getTime() || 0) <
      60 * 1000 * 5;
    const areAnnouncements =
      previousMessage instanceof Announcement &&
      message instanceof Announcement;
    const isSequentialMovedAnnouncement =
      areAnnouncements &&
      previousMessage.kind == "messageMoved" &&
      message.kind == "messageMoved" &&
      previousMessage.relatedThreads.ids()[0] ==
        message.relatedThreads.ids()[0];
    const mergeWithPrevious =
      (authorsAreSame && messagesWithin5Minutes) ||
      isSequentialMovedAnnouncement;
    return mergeWithPrevious;
  }
</script>

<VirtualScroll {timeline} items={messages.value}>
  {#snippet children(message, index)}
    {@const previousMessage = index > 0 ? messages.value[index - 1] : undefined}
    {#if !message.softDeleted}
      {#if g.channel?.name !== "@links"}
        <ChatMessage
          {message}
          mergeWithPrevious={shouldMergeWithPrevious(message, previousMessage)}
        />
      {:else if "bodyJson" in message}
        <LinkPreview {message} />
      {/if}
    {:else}
      <p class="italic text-error text-sm">This message has been deleted</p>
    {/if}
  {/snippet}
</VirtualScroll>
