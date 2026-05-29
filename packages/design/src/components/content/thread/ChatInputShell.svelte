<script lang="ts" module>
  export type ChatInputShellMode = "normal" | "replying" | "threading" | "commenting";
</script>

<script lang="ts">
  import type { Snippet } from "svelte";
  import Button from "../../ui/button/Button.svelte";
  import Input from "../../ui/input/Input.svelte";
  import Popover from "../../ui/popover/Popover.svelte";
  import {
    IconCloseCircle,
    IconNeedleThread,
    IconX,
    IconSend,
    IconImage,
    IconPlus,
    IconLoading,
  } from "../../../icons";

  type Props = {
    /** Whether the current user can post in this room. `undefined` while loading. */
    canWrite: boolean | undefined;
    /** Whether a message is currently being sent. */
    isSendingMessage: boolean;
    /** Local object-URLs for image / video previews. */
    previewImages: string[];
    /** Current mode for the input area. */
    mode: ChatInputShellMode;
    /** Whether the popover action menu is open. */
    actionMenuOpen: boolean;
    /** Threading: name of the thread being created. */
    threadName?: string;
    /** Threading: number of currently selected messages. */
    threadSelectedCount?: number;
    /** Whether the send button should be visible (input has content or files). */
    canSend: boolean;
    /** Whether to render the context preview bar (reply / thread / comment). */
    showContextPreview: boolean;

    /** Action menu open state change. */
    onActionMenuOpenChange: (open: boolean) => void;
    /** Clear the current context (reply / thread / comment). */
    onClearContext: () => void;
    /** Send the current message. */
    onSend: () => void;
    /** Click "Upload Media" in the popover. */
    onUploadMedia: () => void;
    /** Click "Create Thread" in the popover. */
    onCreateThreadFromMenu: () => void;
    /** Submit the thread-creation form. */
    onCreateThread: () => void;
    /** Remove a preview image by index. */
    onRemoveImage: (index: number) => void;
    /** Update the thread name. */
    onThreadNameChange: (name: string) => void;
    /** Files chosen via the hidden <input type=file>. */
    onFileInput: (event: Event) => void;
    /** Bind the hidden file input element to wire it to a callback like `fileInput?.click()`. */
    bindFileInput?: (el: HTMLInputElement | undefined) => void;

    /** Slot: context preview content (reply target / thread summary / comment snippet). */
    contextPreview?: Snippet;
    /** Slot: the rich text input area (e.g. ChatInput). */
    input: Snippet;
    /** Slot: optional fullscreen image dropper (or any extra overlay). */
    fullscreenDropper?: Snippet;
  };

  let {
    canWrite,
    isSendingMessage,
    previewImages,
    mode,
    actionMenuOpen,
    threadName = "",
    threadSelectedCount = 0,
    canSend,
    showContextPreview,
    onActionMenuOpenChange,
    onClearContext,
    onSend,
    onUploadMedia,
    onCreateThreadFromMenu,
    onCreateThread,
    onRemoveImage,
    onThreadNameChange,
    onFileInput,
    bindFileInput,
    contextPreview,
    input,
    fullscreenDropper,
  }: Props = $props();

  let fileInput: HTMLInputElement | undefined = $state();
  $effect(() => {
    bindFileInput?.(fileInput);
  });
</script>

<div class="flex-none pt-2 pb-2 pr-2">
  {#if showContextPreview}
    <div
      class="flex justify-between bg-secondary text-secondary-content rounded-t-lg p-2 gap-2 pr-0"
    >
      {#if mode === "replying"}
        <div class="flex items-center gap-1 overflow-hidden text-xs w-full">
          {@render contextPreview?.()}
        </div>
        <Button
          variant="ghost"
          onclick={onClearContext}
          class="flex-shrink-0"
        >
          <IconCloseCircle />
        </Button>
      {:else if mode === "threading"}
        <div
          class="px-2 flex flex-wrap items-center gap-1 overflow-hidden text-xs w-full"
        >
          <span class="shrink-0 text-base-900 dark:text-base-100"
            >Creating thread with</span
          >
          {#if threadSelectedCount > 0}
            <div class="max-w-[28rem]">
              {@render contextPreview?.()}
            </div>
          {/if}
          {#if threadSelectedCount > 1}
            <span class="shrink-0 text-base-900 dark:text-base-100"
              >and {threadSelectedCount - 1} other message{threadSelectedCount >
              2
                ? "s"
                : ""}</span
            >
          {:else if threadSelectedCount === 0}
            <span class="shrink-0 text-base-900 dark:text-base-100"
              >no messages</span
            >
          {/if}
        </div>
        <Button
          variant="ghost"
          onclick={onClearContext}
          class="flex-shrink-0"
        >
          <IconCloseCircle />
        </Button>
      {:else if mode === "commenting"}
        <div class="flex items-center gap-1 overflow-hidden text-xs w-full">
          {@render contextPreview?.()}
        </div>
        <Button
          variant="ghost"
          onclick={onClearContext}
          class="flex-shrink-0"
        >
          <IconCloseCircle />
        </Button>
      {/if}
    </div>
  {/if}

  <div class="w-full py-1">
    <div class="prose-a:text-primary prose-a:underline relative isolate">
      {#if canWrite === false}
        <div
          class="flex items-center justify-center px-4 py-3 text-sm text-base-500 dark:text-base-400 bg-base-50 dark:bg-base-800 rounded-lg mx-2 mb-1"
        >
          You don't have permission to send messages in this channel.
        </div>
      {:else if canWrite === undefined}
        <div
          class="flex items-center justify-center px-4 py-3 bg-base-50 dark:bg-base-800 rounded-lg mx-2 mb-1"
        >
          <div class="h-4 w-64 animate-pulse rounded bg-base-200 dark:bg-base-700"></div>
        </div>
      {/if}
      {#if previewImages.length > 0}
        <div class="flex gap-2 my-2 overflow-x-auto w-full px-2">
          {#each previewImages as previewImage, index (previewImage)}
            <div
              class={[
                "size-24 relative shrink-0",
                isSendingMessage ? "opacity-60" : "",
              ]}
            >
              <img
                src={previewImage}
                alt="Preview"
                class="absolute inset-0 w-full h-full object-cover"
              />

              <Button
                disabled={isSendingMessage}
                variant="ghost"
                class="absolute p-0.5 top-1 right-1 bg-base-100 hover:bg-base-200 dark:bg-base-900 dark:hover:bg-base-800 rounded-full disabled:hidden"
                onclick={() => onRemoveImage(index)}
              >
                <IconX class="size-4" />
              </Button>
            </div>
          {/each}
        </div>
      {/if}

      {#if canWrite === true}
        <div class="flex w-full gap-2 items-center">
          {#if mode === "threading"}
            <form
              onsubmit={(e) => {
                e.preventDefault();
                onCreateThread();
              }}
              class="flex w-full gap-2"
            >
              <label for="thread-name" class="pl-4 py-2 text-xs font-medium"
                >Thread name:</label
              >
              <Input
                disabled={isSendingMessage}
                value={threadName}
                oninput={(e) =>
                  onThreadNameChange(
                    (e.currentTarget as HTMLInputElement).value,
                  )}
                id="thread-name"
                class="grow ml-2 disabled:opacity-50"
              />

              <Button type="submit"><IconNeedleThread />Create Thread</Button>
            </form>
          {:else}
            {#if isSendingMessage}
              <div class="flex items-center justify-center p-3 ml-2">
                <IconLoading class="animate-spin text-base-500" />
              </div>
            {:else}
              <Popover
                open={actionMenuOpen}
                onOpenChange={onActionMenuOpenChange}
                side="top"
                sideOffset={8}
                align="start"
                class="p-2"
              >
                {#snippet child({ props })}
                  <Button
                    variant="ghost"
                    {...props}
                    class="ml-2 rounded-full"
                    size="iconLg"
                    aria-label="Actions"
                  >
                    <IconPlus class="" />
                  </Button>
                {/snippet}
                <div class="flex flex-col items-start justify-stretch gap-1">
                  <Button
                    variant="ghost"
                    class="w-full justify-start gap-2"
                    onclick={onUploadMedia}
                  >
                    <IconImage class="size-4" />
                    Upload Media
                  </Button>
                  <Button
                    variant="ghost"
                    class="w-full justify-start gap-2"
                    onclick={onCreateThreadFromMenu}
                  >
                    <IconNeedleThread class="size-4" />
                    Create Thread
                  </Button>
                </div>
              </Popover>

              <input
                type="file"
                multiple
                accept="image/*,video/mp4"
                onchange={onFileInput}
                class="hidden"
                bind:this={fileInput}
              />
            {/if}

            {@render input()}

            {#if !isSendingMessage && canSend}
              <Button
                data-testid="send-message-button"
                onclick={onSend}
                variant="primary"
                size="icon"
                class="shrink-0 rounded-full"
              >
                <IconSend />
              </Button>
            {/if}
          {/if}
        </div>
      {/if}
      {@render fullscreenDropper?.()}
    </div>
  </div>
</div>
