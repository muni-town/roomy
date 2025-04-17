<script lang="ts">
  import { onMount, onDestroy, untrack } from "svelte";
  import { Editor } from "@tiptap/core";
  import StarterKit from "@tiptap/starter-kit";
  import Placeholder from "@tiptap/extension-placeholder";
  import {
    type Item,
    initKeyboardShortcutHandler,
    initUserMention,
    initSpaceContextMention,
  } from "$lib/tiptap/editor";
  import { g } from "$lib/global.svelte";

  type Props = {
    content: Record<any, any>;
    users: Item[];
    context: Item[];
    onEnter: () => void;
    placeholder?: string;
  };

  let { content = $bindable({}), users, context, onEnter, placeholder = "Write something ..." }: Props = $props();
  let element: HTMLDivElement | undefined = $state();
  let extensions = $derived([
    StarterKit.configure({ heading: false }),
    Placeholder.configure({ placeholder }),
    initKeyboardShortcutHandler({ onEnter }),
    initUserMention({ users }),
    initSpaceContextMention({ context }),
  ]);

  let tiptap: Editor;
  let hasFocus = false;

  onMount(() => {
    tiptap = new Editor({
      element,
      extensions,
      content: content.type ? content : { type: "doc", content: [] },
      editorProps: {
        attributes: {
          class:
            "w-full px-3 py-2 rounded bg-base-300 text-base-content outline-none",
        },
      },
      onUpdate: (ctx) => {
        content = ctx.editor.getJSON();
      },
      onFocus: () => {
        hasFocus = true;
      },
      onBlur: () => {
        hasFocus = false;
      },
    });
  });

  $effect(() => {
    // Store focus state and cursor position before destroying
    const wasFocused = hasFocus;
    let cursorPos = null;
    
    if (tiptap && wasFocused) {
      try {
        // Save the current selection state
        const { from, to } = tiptap.state.selection;
        cursorPos = { from, to };
      } catch (e) {
        console.error("Failed to save cursor position:", e);
      }
    }
    
    untrack(() => tiptap?.destroy());
    
    tiptap = new Editor({
      element,
      extensions,
      content: content.type ? content : { type: "doc", content: [] },
      editorProps: {
        attributes: {
          class:
            "w-full px-3 py-2 rounded bg-base-300 text-base-content outline-none",
        },
      },
      onUpdate: (ctx) => {
        content = ctx.editor.getJSON();
      },
      onFocus: () => {
        hasFocus = true;
      },
      onBlur: () => {
        hasFocus = false;
      },
    });
    
    // Restore focus and cursor position if it was focused before
    if (wasFocused) {
      setTimeout(() => {
        tiptap.commands.focus();
        
        // Restore cursor position if we have it
        if (cursorPos) {
          try {
            const { from, to } = cursorPos;
            const { state, view } = tiptap;
            const tr = state.tr.setSelection(state.selection.constructor.create(state.doc, from, to));
            view.dispatch(tr);
          } catch (e) {
            console.error("Failed to restore cursor position:", e);
          }
        }
      }, 0);
    }
  });

  onDestroy(() => {
    tiptap?.destroy();
  });
</script>

{#if !g.isBanned}
  <div bind:this={element}></div>
{:else}
  <div
    class="w-full px-3 py-2 rounded bg-base-300 text-base-content outline-none cursor-not-allowed"
  >
    Your account has been banned in this space.
  </div>
{/if}
