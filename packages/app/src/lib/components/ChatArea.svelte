<script lang="ts">
  import { ScrollArea } from "bits-ui";
  import ChatMessage from "./ChatMessage.svelte";
  import { Virtualizer } from "virtua/svelte";
  import { page } from "$app/state";
  import { setContext } from "svelte";
  import { Account, co } from "jazz-tools";
  import type { Space } from "$lib/jazz/schema";

  let {
    timeline,
    virtualizer = $bindable(),
    isAdmin = false,
    admin,
    space,
    threadId,
    allowedToInteract,
  }: {
    timeline: string[];
    virtualizer?: Virtualizer<string>;
    isAdmin?: boolean;
    admin: co.loaded<typeof Account> | undefined | null;
    space: co.loaded<typeof Space> | undefined | null;
    threadId?: string;
    allowedToInteract?: boolean;
  } = $props();

  let showLastN = $state(50);

  let slicedTimeline = $derived(timeline.slice(-showLastN));

  let viewport: HTMLDivElement = $state(null!);

  setContext("scrollToMessage", (id: string) => {
    const idx = timeline.indexOf(id);
    if (idx !== -1 && virtualizer) virtualizer.scrollToIndex(idx);
  });

  $effect(() => {
    page.route; // Scroll-to-end when route changes

    if (!viewport || !virtualizer) return;
    if (timeline) {
      virtualizer.scrollToIndex(timeline.length - 1, { align: "start" });
    }
  });
</script>

<ScrollArea.Root type="scroll" class="h-full overflow-hidden">
  <ScrollArea.Viewport
    bind:ref={viewport}
    class="relative max-w-full w-full h-full"
  >
    <div class="flex flex-col w-full h-full pb-16">
      {#if slicedTimeline.length < timeline.length}
        <button class="btn btn-sm btn-outline" onclick={() => showLastN += 50}>Load More</button>
      {/if}
      <ol class="flex flex-col gap-2 max-w-full">
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
            data={slicedTimeline || []}
            getKey={(messageId) => messageId}
            scrollRef={viewport}
            overscan={50}
            shift
          >
            {#snippet children(messageId: string, index: number)}
              <ChatMessage
                {messageId}
                previousMessageId={slicedTimeline[index - 1]}
                {isAdmin}
                {admin}
                {space}
                {threadId}
                {allowedToInteract}
              />
            {/snippet}
          </Virtualizer>
        {/key}
      </ol>
    </div>
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
