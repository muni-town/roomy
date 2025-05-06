<script lang="ts" generics="T">
  import { ScrollArea } from "bits-ui";
  import { Virtualizer } from "virtua/svelte";
  import { setContext, type Snippet } from "svelte";
  import type { EntityIdStr, Timeline } from "@roomy-chat/sdk";
  import { page } from "$app/state";

  let {
    items,
    timeline,
    children: child,
  }: {
    items: T[];
    timeline: Timeline;
    children: Snippet<[T, number]>;
  } = $props();

  setContext("scrollToMessage", (id: EntityIdStr) => {
    const idx = timeline.timeline.ids().indexOf(id);
    if (idx !== -1 && virtualizer)
      virtualizer.scrollToIndex(idx, { smooth: true });
  });

  // ScrollArea
  let viewport: HTMLDivElement = $state(null!);
  let virtualizer: Virtualizer<string> | undefined = $state();

  $effect(() => {
    page.route; // Scroll-to-end when route changes
    items; // Scroll to end when message list changes.
    if (viewport) {
      setTimeout(() => {
        if (virtualizer) virtualizer.scrollToIndex(items.length - 1);
      });
    }
  });
</script>

<ScrollArea.Root type="scroll" class="h-full overflow-hidden relative">
  <ScrollArea.Viewport bind:ref={viewport} class="w-full max-w-full h-full">
    <ol class="flex flex-col gap-2 max-w-full">
      <!--
        This use of `key` needs explaining. `key` causes the components below
        it to be deleted and re-created when the expression passed to it is changed.
        This means that every time the `viewport` binding is updated, the virtualizer
        will be re-created. This is important because the virtualizer only actually sets
        up the scrollRef when it is mounted. And `viewport` is technically only assigned after
        _this_ parent component is mounted. Leading to a chicken-egg problem.

        Once the `viewport` is assigned, the virtualizer has already been mounted with scrollRef
        set to `undefined`, and it won't be re-calculated.

        By using `key` we make sure that the virtualizer is re-mounted after the `viewport` is
        assigned, so that it's scroll integration works properly.
      -->

      {#key viewport}
        <Virtualizer
          bind:this={virtualizer}
          data={items}
          getKey={(k, _) => k}
          scrollRef={viewport}
        >
          {#snippet children(message, index: number)}
            {@render child(message, index)}
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
      class="relative flex-1 rounded-full bg-base-300 transition-opacity"
    />
  </ScrollArea.Scrollbar>
  <ScrollArea.Corner />
</ScrollArea.Root>
