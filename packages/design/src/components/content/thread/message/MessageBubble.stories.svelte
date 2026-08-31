<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import MessageBubble from "./MessageBubble.svelte";

  const { Story } = defineMeta({
    title: "Content/Thread/Message/MessageBubble",
    component: MessageBubble,
  });
</script>

{#snippet template(args: { authorName: string; isBridged: boolean; isSystem: boolean; mergeWithPrevious: boolean })}
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
      onAvatarClick={() => {}}
    >
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
