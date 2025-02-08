<script lang="ts">
  import { ScrollArea } from "bits-ui";
  import ChatMessage from "./ChatMessage.svelte";
  import type { Autodoc } from "$lib/autodoc/peer";
  import type { Channel } from "$lib/schemas/types";

  let { channel }: { channel: Autodoc<Channel> } = $props();

  // ScrollArea
  let viewport: HTMLDivElement | undefined = $state();

  // Go to the end of the ScrollArea
  $effect(() => {
    if (viewport && channel.view.messages) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  });
</script>

<ScrollArea.Root>
  <ScrollArea.Viewport bind:el={viewport} class="w-full h-full">
    <ScrollArea.Content>
      <ol class="flex flex-col gap-4">
        {#each channel.view.timeline as id (id)}
          <ChatMessage {id} {channel} />
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
