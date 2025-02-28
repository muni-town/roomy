<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { Editor } from "@tiptap/core";
  import StarterKit from "@tiptap/starter-kit";
  import { 
    type Item,
    initKeyboardShortcutHandler, 
    initUserMention, 
    initThreadMention 
  } from "$lib/tiptap/editor";

  type Props = {
    content: Record<any, any>;
    users: Item[];
    threads: Item[];
    onEnter: () => void;
  };

  let { content = $bindable({}), users, threads, onEnter }: Props = $props();
  let element: HTMLDivElement | undefined = $state();
  let tiptap: Editor | undefined = $state();

  $inspect({ content });

  onMount(() => {
    const extensions = [
      StarterKit.configure({ heading: false }),
      initKeyboardShortcutHandler({ onEnter }),
      initUserMention({ users }),
      initThreadMention({ threads })
    ];

    tiptap = new Editor({
      element,
      extensions,
      content: () => content,
      editorProps: {
        attributes: {
          class: "w-full px-3 py-2 rounded bg-violet-900 text-white"
        },
      },
      onUpdate: (context) => {
        content = context.editor.getJSON();
      }
    });
  });

  onDestroy(() => { 
    tiptap?.destroy(); 
  });
</script>

<div bind:this={element}></div>