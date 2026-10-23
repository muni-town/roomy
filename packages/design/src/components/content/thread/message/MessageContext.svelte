<script lang="ts" module>
  /**
   * What the strip above the composer is previewing: the message being replied
   * to, or the messages a thread is being created from.
   */
  export type MessageContextReplying = {
    kind: "replying";
    replyTo: { id: string };
  };

  export type MessageContextThreading = {
    kind: "threading";
    selectedMessages: { content: string; mimeType?: string }[];
  };

  export type MessageContext = MessageContextReplying | MessageContextThreading;
</script>

<script lang="ts">
  /**
   * MessageContext — the full-width strip the composer grows when the pending
   * message is a reply or a new thread.
   *
   * Presentational only: the preview itself belongs to the caller, which is
   * the side that can read the replied-to message. The strip owns the frame
   * and the one interaction the frame carries — clicking a reply context
   * scrolls the timeline to the message being replied to.
   */
  import type { Snippet } from "svelte";

  let {
    context,
    onScrollToMessage,
    replyPreview,
    threadPreview,
  }: {
    context: MessageContext;
    /** Jumps the timeline to the message being replied to. */
    onScrollToMessage?: (messageId: string) => void;
    /** Rendered in place of the reply context line (see {@link MessageContextReply}). */
    replyPreview?: Snippet;
    /** Rendered in place of the thread's first-message preview. */
    threadPreview?: Snippet;
  } = $props();
</script>

<button
  onclick={() => {
    if (context.kind === "replying") {
      onScrollToMessage?.(context.replyTo.id);
    }
  }}
  class="cursor-pointer flex gap-2 text-sm text-start items-center pl-2 pr-4 py-1 w-full"
>
  {#if context.kind === "replying"}
    {@render replyPreview?.()}
  {:else if context.kind === "threading"}
    <div class="line-clamp-1 overflow-hidden italic">
      {@render threadPreview?.()}
    </div>
  {/if}
</button>
