<script module lang="ts">
  let editor: Editor;
  export function setInputFocus() {
    if (!editor) return;
    editor.commands.focus();
  }
  export function clearInput() {
    if (!editor) return;
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
  import { RichTextLink } from "$lib/tiptap/RichTextLink";
  import { cn, inputVariants } from "@fuxui/base";
  import { Markdown } from "tiptap-markdown";

  type Props = {
    content: string;
    /** Users who can be mentioned with @mention */
    users?: Item[];
    /** Rooms in space that can be mentioned with #room */
    context?: Item[];
    onEnter: (content: string) => Promise<void>;
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
      Markdown,
    ];

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
