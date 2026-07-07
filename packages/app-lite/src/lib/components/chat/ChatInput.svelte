<script module lang="ts">
  let editor: Editor | undefined;
  export function setInputFocus() {
    if (!editor || editor.isDestroyed) return;
    editor.commands.focus();
  }
  export function clearInput() {
    if (!editor || editor.isDestroyed) return;
    editor.commands.clearContent();
  }
</script>

<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { Editor, Extension } from "@tiptap/core";
  import StarterKit from "@tiptap/starter-kit";
  import Placeholder from "@tiptap/extension-placeholder";
  import { initUserMention, initSpaceContextMention } from "$lib/tiptap/editor";
  import { type Item, initKeyboardShortcutHandler } from "$lib/tiptap/editor";
  import type { TypeaheadUser } from "@roomy/design/components/ui/user-typeahead/UserTypeahead.svelte";
  import { RichTextLink } from "$lib/tiptap/RichTextLink";
  import { cn } from "@roomy/design/utils";
  import { Markdown } from "tiptap-markdown";

  type Props = {
    content: string;
    /** Server-search fetcher for `@user` mentions (hits `getMembers?search=`). */
    mentionSearch?: (query: string) => Promise<TypeaheadUser[]>;
    /** Rooms in space that can be mentioned with #room */
    context?: Item[];
    onEnter: (content: string) => Promise<void>;
    placeholder?: string;
    setFocus?: boolean;
    disabled?: boolean;
    processImageFile?: (file: File) => void;
  };

  let {
    content = $bindable(""),
    mentionSearch,
    context,
    onEnter,
    placeholder = "Write something ...",
    setFocus = false,
    disabled = false,
    processImageFile,
  }: Props = $props();
  let element: HTMLDivElement | undefined = $state();

  let tiptap: Editor | undefined = $state();

  async function wrappedOnEnter() {
    await onEnter(content);
  }

  onMount(() => {
    const extensions = [
      StarterKit.configure({ heading: false }),
      Placeholder.configure({ placeholder }),
      RichTextLink.configure({
        openOnClick: false,
        autolink: true,
        defaultProtocol: "https",
      }),
      initKeyboardShortcutHandler({ onEnter: wrappedOnEnter }),
      Markdown,
    ];

    if (mentionSearch) {
      extensions.push(initUserMention({ search: mentionSearch }) as Extension);
    }
    if (context) {
      extensions.push(initSpaceContextMention({ context }) as Extension);
    }

    tiptap = new Editor({
      element,
      extensions,
      content,
      editable: !disabled,
      editorProps: {
        attributes: {
          class: cn(
            // inputVariants({ variant: "primary" }),
            "w-full outline-none text-base-950 dark:text-base-50",
            "max-h-[30vh] overflow-y-auto",
          ),
        },
      },
      onUpdate: (ctx) => {
        content = ctx.editor.storage.markdown.getMarkdown();
      },
    });
    editor = tiptap;
    if (setFocus) {
      // focus at the end of the content
      tiptap?.commands.focus("end");
    }
  });

  $effect(() => {
    tiptap?.setEditable(!disabled);
    if (!disabled) setInputFocus();
  });

  onDestroy(() => {
    tiptap?.destroy();
    // Reset the shared module-level binding so deferred setInputFocus/clearInput
    // calls (e.g. from messagingState.setNormal() in a route $effect) don't
    // land on a destroyed editor whose commandManager is null.
    editor = undefined;
  });

  const handlePaste = (event: ClipboardEvent) => {
    if (!processImageFile) return;

    const items = event.clipboardData?.items;
    if (!items) return;

    for (const item of Array.from(items)) {
      if (!item.type.startsWith("image/") && !item.type.startsWith("video/"))
        continue;
      const file = item.getAsFile();
      if (!file) continue;
      event.preventDefault();
      processImageFile(file);
    }
  };
</script>

<!-- Tiptap editor -->
<div
  id="chat-input"
  onpaste={handlePaste}
  bind:this={element}
  class="flex-1 relative"
  role="region"
  aria-label="Chat editor"
></div>

<style>
  :global(.tiptap .is-empty::before) {
    color: var(--color-base-500);
    content: attr(data-placeholder);
    float: left;
    height: 0;
    pointer-events: none;
  }

  /* Mention chip rendered inline in the composer. Subtle accent rounded
     background + accent text; works in both themes because the bg is a
     translucent accent mix. Dark mode uses a lighter accent text color. */
  :global(.tiptap .mention) {
    background-color: color-mix(
      in oklab,
      var(--color-accent-500) 14%,
      transparent
    );
    color: var(--color-accent-700);
    border-radius: 0.375rem;
    padding: 0.05rem 0.3rem;
    font-weight: 500;
    text-decoration: none;
    cursor: default;
  }
  :global(.dark .tiptap .mention) {
    color: var(--color-accent-300);
  }
</style>
