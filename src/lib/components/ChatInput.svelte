<script lang="ts">
  import { onMount, onDestroy, untrack } from "svelte";
  import { Editor } from "@tiptap/core";
  import StarterKit from "@tiptap/starter-kit";
  import Placeholder from "@tiptap/extension-placeholder";
  import { 
    type Item,
    initKeyboardShortcutHandler, 
    initUserMention, 
    initSpaceContextMention
  } from "$lib/tiptap/editor";

  type Props = {
    content: Record<any, any>;
    users: Item[];
    context: Item[];
    onEnter: () => void;
  };

  let { content = $bindable({}), users, context, onEnter }: Props = $props();
  console.log('chat input content', content);
  let element: HTMLDivElement | undefined = $state();
  let extensions = $derived([
    StarterKit.configure({ heading: false }),
    Placeholder.configure({ placeholder: "Write something ..." }),
    initKeyboardShortcutHandler({ onEnter }),
    initUserMention({ users }),
    initSpaceContextMention({ context })
  ]);

  let tiptap: Editor | undefined = $state();

  onMount(() => {
    tiptap = new Editor({
      element,
      extensions,
      content, 
      editorProps: {
        attributes: {
          class: "w-full px-3 py-2 rounded bg-base-300 text-base-content outline-none"
        },
      },
      onUpdate: (ctx) => {
        content = ctx.editor.getJSON();
      }
    });
  });

  $effect(() => {
    untrack(() => tiptap?.destroy());
    tiptap = new Editor({
      element,
      extensions,
      content: untrack(() => content),
      editorProps: {
        attributes: {
          class: "w-full px-3 py-2 rounded bg-base-300 text-base-content outline-none"
        },
      },
      onUpdate: (ctx) => {
        content = ctx.editor.getJSON();
      }
    });
  });

  onDestroy(() => { 
    tiptap?.destroy(); 
  });
</script>

<div bind:this={element}></div>