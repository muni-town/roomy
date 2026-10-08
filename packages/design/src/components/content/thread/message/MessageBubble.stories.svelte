<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import MessageBubble from "./MessageBubble.svelte";
  import SelectionTick from "./SelectionTick.svelte";

  const { Story } = defineMeta({
    title: "Content/Thread/Message/MessageBubble",
    component: MessageBubble,
  });
</script>

{#snippet template(args: { authorName: string; isBridged: boolean; isSystem: boolean; mergeWithPrevious: boolean; isSelected?: boolean; selectionTick?: boolean; deliveryState?: "pending" | "failed" | "queued"; queuedLabel?: string })}
  <div class="w-full max-w-2xl p-4">
    <MessageBubble
      authorDid="did:plc:test"
      authorName={args.authorName}
      authorHandle="alice"
      authorAvatarUrl="https://placehold.co/64x64/6366f1/ffffff?text=A"
      timestamp={new Date().toISOString()}
      isBridged={args.isBridged}
      isSystem={args.isSystem}
      mergeWithPrevious={args.mergeWithPrevious}
      isSelected={args.isSelected}
      deliveryState={args.deliveryState}
      queuedLabel={args.queuedLabel}
      onAvatarClick={() => {}}
    >
      {#if args.selectionTick}
        {#snippet selectionIndicator()}
          <SelectionTick checked={args.isSelected ?? false} />
        {/snippet}
      {/if}
      {#snippet content()}
        <p class="text-sm">
          The quick brown fox jumps over the lazy dog. This is a regular
          message body rendered inside the bubble.
        </p>
      {/snippet}
      {#snippet toolbar()}
        <div
          class="flex gap-1 border rounded-full bg-base-50 dark:bg-base-800 px-1 py-0.5 text-xs"
        >
          <span class="px-1">Reply</span>
          <span class="px-1">React</span>
        </div>
      {/snippet}
      {#snippet reactions()}
        <div class="flex gap-1 pl-12">
          <span
            class="rounded-full border border-base-200 dark:border-base-700 px-2 py-0.5 text-xs"
            >👍 2</span
          >
          <span
            class="rounded-full border border-base-200 dark:border-base-700 px-2 py-0.5 text-xs"
            >❤️ 1</span
          >
        </div>
      {/snippet}
      {#snippet deliveryActions()}
        <span class="font-semibold underline">Retry</span>
        <span class="font-semibold underline">Discard</span>
      {/snippet}
    </MessageBubble>
  </div>
{/snippet}

<Story
  name="Default"
  args={{
    authorName: "Alice",
    isBridged: false,
    isSystem: false,
    mergeWithPrevious: false,
  }}
  {template}
/>

<Story
  name="Bridged"
  args={{
    authorName: "Discord Bob",
    isBridged: true,
    isSystem: false,
    mergeWithPrevious: false,
  }}
  {template}
/>

<Story
  name="System"
  args={{
    authorName: "",
    isBridged: false,
    isSystem: true,
    mergeWithPrevious: false,
  }}
  {template}
/>

<Story
  name="Merged"
  args={{
    authorName: "Alice",
    isBridged: false,
    isSystem: false,
    mergeWithPrevious: true,
  }}
  {template}
/>

<!-- An unacknowledged send: dimmed, with a spinner in the avatar's place —
     no status line of its own, so the row does not shift when it resolves. -->
<Story
  name="Pending delivery"
  args={{
    authorName: "Alice",
    isBridged: false,
    isSystem: false,
    mergeWithPrevious: false,
    deliveryState: "pending",
  }}
  {template}
/>

<!-- A send the appserver rejected: dimmed, marked "Not sent", with the retry
     and discard controls the app wires into the deliveryActions slot. -->
<Story
  name="Failed delivery"
  args={{
    authorName: "Alice",
    isBridged: false,
    isSystem: false,
    mergeWithPrevious: false,
    deliveryState: "failed",
  }}
  {template}
/>

<!-- A send held back while the space it targets is set up: dimmed like a
     queued send, but marked as waiting rather than as a rejection, with the
     same retry and discard controls. -->
<Story
  name="Held back (space rematerialising)"
  args={{
    authorName: "Alice",
    isBridged: false,
    isSystem: false,
    mergeWithPrevious: false,
    deliveryState: "queued",
    queuedLabel: "Waiting",
  }}
  {template}
/>

<!-- Multi-select: the tick takes the avatar's place, so the row shows its
     state where identity already lives and the message body never shifts. -->
<Story
  name="Select mode, selected"
  args={{
    authorName: "Alice",
    isBridged: false,
    isSystem: false,
    mergeWithPrevious: false,
    isSelected: true,
    selectionTick: true,
  }}
  {template}
/>

<Story
  name="Select mode, unselected"
  args={{
    authorName: "Alice",
    isBridged: false,
    isSystem: false,
    mergeWithPrevious: false,
    isSelected: false,
    selectionTick: true,
  }}
  {template}
/>
