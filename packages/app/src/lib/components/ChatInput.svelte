<script module>
  let editor: Editor;
  export function setInputFocus() {
    if (!editor) return;
    editor.commands.focus();
  }
</script>
<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { Editor, Extension } from "@tiptap/core";
  import StarterKit from "@tiptap/starter-kit";
  import Placeholder from "@tiptap/extension-placeholder";
  import { initUserMention, initSpaceContextMention } from "$lib/tiptap/editor";
  import { type Item, initKeyboardShortcutHandler } from "$lib/tiptap/editor";
  import { RichTextLink } from "$lib/tiptap/RichTextLink";

  type Props = {
    content: string;
    users?: Item[];
    context?: Item[];
    onEnter: (content: string) => void;
    placeholder?: string;
    setFocus?: boolean;
    processImageFile?: (file: File) => void;
  };

  let {
    content = $bindable(""),
    users,
    context,
    onEnter,
    placeholder = "Write something ...",
    setFocus = false,
    processImageFile,
  }: Props = $props();
  let element: HTMLDivElement | undefined = $state();

  let tiptap: Editor | undefined = $state();

  async function wrappedOnEnter() {
    // add one space at the end to the editor
    tiptap?.commands.insertContent(" ");

    await new Promise((resolve) => setTimeout(resolve, 10));

    onEnter(content);
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
    ]

    if (users) {
      extensions.push(initUserMention({ users }) as Extension);
    }
    if (context) {
      extensions.push(initSpaceContextMention({ context }) as Extension);
    }
    
    tiptap = new Editor({
      element,
      extensions,
      content,
      editorProps: {
        attributes: {
          class:
            "w-full px-3 py-2 rounded bg-base-300 text-base-content outline-none",
        },
      },
      onUpdate: (ctx) => {
        content = ctx.editor.getHTML();
      },
    });
    editor = tiptap
    if (setFocus) {
      // focus at the end of the content
      tiptap?.commands.focus();
      tiptap?.commands.setTextSelection({
        from: content.length,
        to: content.length,
      });
    }
  });

  onDestroy(() => {
    tiptap?.destroy();
  });

  const handlePaste = (event: ClipboardEvent) => {
    if (!processImageFile) return;

    const items = event.clipboardData?.items;
    if (!items) return;

    for (const item of Array.from(items)) {
      if (!item.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (!file) continue;
      event.preventDefault();
      processImageFile(file);
    }
  };
</script>

<!-- Tiptap editor -->
<div
  onpaste={handlePaste}
  bind:this={element}
  class="flex-1 relative"
  role="region"
  aria-label="Chat editor"
></div>
