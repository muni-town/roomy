<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { Editor, mergeAttributes, type JSONContent } from "@tiptap/core";
  import StarterKit from "@tiptap/starter-kit";
  import Placeholder from "@tiptap/extension-placeholder";
  import Image from "@tiptap/extension-image";
  import { initUserMention, initSpaceContextMention } from "$lib/tiptap/editor";
  import { type Item, initKeyboardShortcutHandler } from "$lib/tiptap/editor";
  import { globalState } from "$lib/global.svelte";
  import { RichTextLink } from "$lib/tiptap/RichTextLink";

  type Props = {
    content: string;
    users: Item[];
    context: Item[];
    onEnter: (content: string) => void;
    placeholder?: string;
    editMode?: boolean; // Add this to indicate if the component is being used for editing
    setFocus?: boolean;
  };

  let {
    content = $bindable(""),
    users,
    context,
    onEnter,
    placeholder = "Write something ...",
    setFocus = false,
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
    tiptap = new Editor({
      element,
      extensions: [
        StarterKit.configure({ heading: false }),
        Placeholder.configure({ placeholder }),
        RichTextLink.configure({
          openOnClick: false,
          autolink: true,
          defaultProtocol: "https",
        }),
        initKeyboardShortcutHandler({ onEnter: wrappedOnEnter }),
        initUserMention({ users }),
        initSpaceContextMention({ context }),
      ],
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
</script>

<div class="flex items-center gap-2">
  <!-- Tiptap editor -->
  <div
    bind:this={element}
    class="flex-1 relative"
    role="region"
    aria-label="Chat editor and image drop area"
  ></div>
</div>

<style>
  /* Style for local image previews */
  :global(.local-image) {
    border: 2px dashed #3498db !important;
    border-radius: 4px !important;
    padding: 2px !important;
  }

  /* Container for local images to allow for the label */
  :global(.image-container) {
    position: relative;
    display: inline-block;
    margin: 2px;
  }

  /* Label for local images */
  :global(.local-image-label) {
    position: absolute;
    top: 0;
    left: 0;
    background-color: rgba(52, 152, 219, 0.7);
    color: white;
    font-size: 10px;
    padding: 2px 4px;
    border-bottom-right-radius: 4px;
    pointer-events: none;
    z-index: 1;
  }
</style>
