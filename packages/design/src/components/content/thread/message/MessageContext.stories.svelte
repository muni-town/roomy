<script lang="ts" module>
  import { type ComponentProps } from "svelte";
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import MessageContext, {
    type MessageContextReplying,
    type MessageContextThreading,
  } from "./MessageContext.svelte";

  const { Story } = defineMeta({
    title: "Content/Thread/Message/MessageContext",
    component: MessageContext,
  });

  const replying: MessageContextReplying = {
    kind: "replying",
    replyTo: { id: "01KZBRQMEP2FTE079YRVDFKGTA" },
  };

  const threading: MessageContextThreading = {
    kind: "threading",
    selectedMessages: [
      { content: "The first selected message", mimeType: "text/plain" },
      { content: "Another one", mimeType: "text/plain" },
    ],
  };
</script>

{#snippet template(args: ComponentProps<typeof MessageContext>)}
  <div class="w-full max-w-xl">
    <MessageContext context={args.context}>
      {#snippet replyPreview()}
        <span class="italic">Replying to a message preview</span>
      {/snippet}
      {#snippet threadPreview()}
        <span>The first selected message</span>
      {/snippet}
    </MessageContext>
  </div>
{/snippet}

<Story name="Replying" args={{ context: replying }} {template} />

<Story name="Threading" args={{ context: threading }} {template} />
