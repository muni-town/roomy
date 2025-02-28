<script lang="ts">
  import { ScrollArea } from "bits-ui";
  import { onNavigate } from "$app/navigation";
  import ChatMessage from "./ChatMessage.svelte";
  import type { Autodoc } from "$lib/autodoc/peer";
  import type { Channel, Message, Space } from "$lib/schemas/types";
  import { Virtualizer } from "virtua/svelte";
  import { setContext } from "svelte";

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

  setContext("scrollToMessage", (id: string) => {
    const idx = timeline.indexOf(id);
    if (idx !== -1 && virtualizer)
      virtualizer.scrollToIndex(idx, { smooth: true });
  });

  // ScrollArea
  let viewport: HTMLDivElement = $state(null!);
  let virtualizer: Virtualizer<string> | undefined = $state();

  // Go to the end of the ScrollArea
  let scrollToEnd = $state(false);
  onNavigate(() => {
    setTimeout(() => {
      if (virtualizer) virtualizer.scrollToIndex(timeline.length - 1);
    }, 100);
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

  $inspect({ messages });
</script>

<ScrollArea.Root type="always">
  <ScrollArea.Viewport bind:ref={viewport} class="w-full max-w-full h-full">
    <ol class="flex flex-col gap-4 max-w-full">
      <!--
        This use of `key` needs explaining. `key` causes the components below
        it to be deleted and re-created when the expression passed to it is changed.
        This means that every time the `viewport` binding si updated, the virtualizer
        will be re-created. This is important because the virtualizer only actually sets
        up the scrollRef when is mounted. And `viewport` is technically only assigned after
        _this_ parent component is mounted. Leading to a chicken-egg problem.

        Once the `viewport` is assigned, the virtualizer has already been mounted with scrollRef
        set to `undefined`, and it won't be re-calculated.

        By using `key` we make sure that the virtualizer is re-mounted after the `viewport` is
        assigned, so that it's scroll integration works properly.
      -->
      {#key viewport}
        <Virtualizer
          bind:this={virtualizer}
          data={timeline || []}
          getKey={(k, _) => k}
          scrollRef={viewport}
        >
          {#snippet children(id, _index)}
            {@const message = messages[id]}
            <ChatMessage 
              {id} 
              {message}
              messageRepliedTo={
                message.replyTo 
                ? messages[message.replyTo] as Message 
                : undefined
              }
            />
          {/snippet}
        </Virtualizer>
      {/key}
    </ol>
  </ScrollArea.Viewport>
  <ScrollArea.Scrollbar
    orientation="vertical"
    class="flex h-full w-2.5 touch-none select-none rounded-full border-l border-l-transparent p-px transition-all hover:w-3 hover:bg-dark-10 mr-1"
  >
    <ScrollArea.Thumb
      class="relative flex-1 rounded-full bg-violet-950 transition-opacity"
    />
  </ScrollArea.Scrollbar>
  <ScrollArea.Corner />
</ScrollArea.Root>