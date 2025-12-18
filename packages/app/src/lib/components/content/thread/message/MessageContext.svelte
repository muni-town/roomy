<script lang="ts" module>
  import type { Message } from "../ChatArea.svelte";

  type MessageContextReplying = {
    kind: "replying";
    messageId?: Ulid;
    replyTo: { id: Ulid };
  };

  export type MessageContextThreading = {
    kind: "threading";
    messageId?: Ulid;
    selectedMessages: Message[];
  };

  export type MessageContextCommenting = {
    kind: "commenting";
    messageId?: Ulid;
    comment: {
      snippet?: string;
      version: Ulid; // ULID of the edit version
      from: number;
      to: number;
    };
  };

  export type MessageContext =
    | MessageContextReplying
    | MessageContextThreading
    | MessageContextCommenting;
</script>

<script lang="ts">
  import { Button } from "bits-ui";
  import { getContext } from "svelte";

  import IconHeroiconsChatBubbleBottomCenterText from "~icons/heroicons/chat-bubble-bottom-center-text";
  import MessageContextReply from "./MessageContextReply.svelte";
  import type { Ulid } from "$lib/schema";

  let {
    context = $bindable(undefined),
  }: {
    context?: MessageContext;
  } = $props();

  if (!context) throw new Error("No relevant context");

  console.log("context", context);

  const scrollToMessage = getContext("scrollToMessage") as (id: string) => void;
</script>

{#if context.kind === "replying" || (context.kind === "commenting" && context.comment.snippet)}
  <Button.Root
    onclick={() => {
      if (context.kind === "replying") {
        scrollToMessage(context.replyTo.id);
      }
    }}
    class="cursor-pointer flex gap-2 text-sm text-start items-center pl-2 pr-4 py-1 bg-base-300/20 dark:bg-base-400/5 w-full rounded-xl"
  >
    {#if context.kind === "replying"}
      <MessageContextReply replyToId={context.replyTo.id} />
    {:else if context.kind === "commenting" && context.comment.snippet}
      <div class="flex md:basis-auto gap-2 items-center shrink-0">
        <IconHeroiconsChatBubbleBottomCenterText width="12px" height="12px" />
        <span
          class="font-medium hidden text-ellipsis text-accent-800 dark:text-accent-300"
          aria-hidden="false"
          aria-label="Commenting on"
        >
          Comment
        </span>
      </div>
      <div class="line-clamp-1 md:basis-auto overflow-hidden italic">
        {context.comment.snippet}
      </div>
    {/if}
  </Button.Root>
{/if}
