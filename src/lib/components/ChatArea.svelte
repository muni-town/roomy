<script lang="ts">
  import { ScrollArea } from "bits-ui";
  import { onNavigate } from "$app/navigation";
  import ChatMessage from "./ChatMessage.svelte";
  import type { Autodoc } from "$lib/autodoc/peer";
  import type { Channel, Space } from "$lib/schemas/types";

  let {
    source,
  }: {
    source:
      | { type: "channel"; channel: Autodoc<Channel> }
      | { type: "space"; space: Autodoc<Space>; channelId: string };
  } = $props();

  let messages = $derived(
    source.type == "channel"
      ? source.channel.view.messages
      : source.space.view.messages,
  );
  let timeline = $derived(
    source.type == "channel"
      ? source.channel.view.timeline
      : source.space.view.channels[source.channelId]?.timeline,
  );

  // ScrollArea
  let viewport: HTMLDivElement | undefined = $state();

  // Go to the end of the ScrollArea
  let scrollToEnd = $state(false);
  onNavigate(() => {
    setTimeout(() => {
      scrollToEnd = true;
    }, 0);
  });
  $effect(() => {
    scrollToEnd;
    viewport;
    messages;
    if (viewport && (messages || scrollToEnd)) {
      viewport.scrollTop = viewport.scrollHeight;
      scrollToEnd = false;
    }
  });
</script>

<ScrollArea.Root>
  <ScrollArea.Viewport bind:el={viewport} class="w-full max-w-screen h-full">
    <ScrollArea.Content>
      <ol class="flex flex-col gap-4">
        {#each timeline as id (id)}
          <ChatMessage {id} {messages} />
        {/each}
      </ol>
    </ScrollArea.Content>
  </ScrollArea.Viewport>
  <ScrollArea.Scrollbar
    orientation="vertical"
    class="flex h-full w-2.5 touch-none select-none rounded-full border-l border-l-transparent p-px transition-all hover:w-3 hover:bg-dark-10"
  >
    <ScrollArea.Thumb
      class="relative flex-1 rounded-full bg-muted-foreground opacity-40 transition-opacity hover:opacity-100"
    />
  </ScrollArea.Scrollbar>
  <ScrollArea.Corner />
</ScrollArea.Root>