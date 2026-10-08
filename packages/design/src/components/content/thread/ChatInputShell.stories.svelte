<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import ChatInputShell from "./ChatInputShell.svelte";

  const { Story } = defineMeta({
    title: "Content/Thread/ChatInputShell",
    component: ChatInputShell,
  });

  type Args = {
    canWrite: boolean | undefined;
    isSendingMessage: boolean;
    previewImages: string[];
    mode: string;
    actionMenuOpen: boolean;
    canSend: boolean;
    showContextPreview: boolean;
    selectedCount?: number;
    threadSelectedCount?: number;
    /** Space admin: select mode also offers Move and Delete. */
    canModerate?: boolean;
  };
</script>

{#snippet template(args: Args)}
  <div class="h-96 w-full">
    <ChatInputShell
      canWrite={args.canWrite}
      isSendingMessage={args.isSendingMessage}
      previewImages={args.previewImages}
      mode={args.mode as "normal"}
      actionMenuOpen={args.actionMenuOpen}
      threadName=""
      threadSelectedCount={args.threadSelectedCount ?? 0}
      selectedCount={args.selectedCount ?? 0}
      canSend={args.canSend}
      showContextPreview={args.showContextPreview}
      onActionMenuOpenChange={() => {}}
      onClearContext={() => {}}
      onSend={() => {}}
      onUploadMedia={() => {}}
      onCreateThreadFromMenu={() => {}}
      onCreateThread={() => {}}
      onForwardSelection={() => {}}
      onMoveSelection={args.canModerate ? () => {} : undefined}
      onDeleteSelection={args.canModerate ? () => {} : undefined}
      onSelectCreateThread={() => {}}
      onRemoveImage={() => {}}
      onThreadNameChange={() => {}}
      onFileInput={() => {}}
      bindFileInput={() => {}}
    >
      {#snippet input()}
        <textarea
          class="textarea textarea-bordered grow min-h-12 max-h-40 w-full rounded-xl resize-none m-2 p-2 bg-base-100 dark:bg-base-900"
          placeholder="Write a message…"
        ></textarea>
      {/snippet}
      {#snippet contextPreview()}
        <span class="truncate">Replying to “hello there” from Alice</span>
      {/snippet}
      {#snippet linkEmbedPreview()}
        <div class="text-xs text-base-500 border rounded p-2">
          Link preview will appear here.
        </div>
      {/snippet}
      {#snippet fullscreenDropper()}
        <div class="pointer-events-none"></div>
      {/snippet}
    </ChatInputShell>
  </div>
{/snippet}

<Story
  name="Default"
  args={{
    canWrite: true,
    isSendingMessage: false,
    previewImages: [],
    mode: "normal",
    actionMenuOpen: false,
    canSend: true,
    showContextPreview: true,
  }}
  {template}
/>

<Story
  name="Loading"
  args={{
    canWrite: undefined,
    isSendingMessage: false,
    previewImages: [],
    mode: "normal",
    actionMenuOpen: false,
    canSend: false,
    showContextPreview: false,
  }}
  {template}
/>

<Story
  name="ReadOnly"
  args={{
    canWrite: false,
    isSendingMessage: false,
    previewImages: [],
    mode: "normal",
    actionMenuOpen: false,
    canSend: false,
    showContextPreview: false,
  }}
  {template}
/>

<!-- Select mode: the composer is replaced by the selection bar, so this is
     the whole bottom-chrome region rather than a strip above an editor. -->
<Story
  name="SelectMode"
  args={{
    canWrite: true,
    isSendingMessage: false,
    previewImages: [],
    mode: "selecting",
    actionMenuOpen: false,
    canSend: false,
    showContextPreview: true,
    selectedCount: 3,
    canModerate: true,
  }}
  {template}
/>
