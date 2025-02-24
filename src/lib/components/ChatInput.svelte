<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { Editor, Extension } from "@tiptap/core";
  import StarterKit from "@tiptap/starter-kit";
  import { keymap } from "@tiptap/pm/keymap";

  let { content = $bindable({}) } = $props();
  let element: HTMLDivElement | undefined = $state();
  let tiptap: Editor | undefined = $state();

  const onSubmit = () => {
    console.log("ENTER", content);
  };

  const KeyboardShortcutHandler = Extension.create({ 
    name: "keyboardShortcutHandler", 
    addProseMirrorPlugins() { 
      return [
        keymap({ 
          "Enter": () => {
            onSubmit();
            this.editor.commands.clearContent();
            return true;
          }
        }),
      ]
    }
  });

  onMount(() => {
    tiptap = new Editor({
      element,
      extensions: [
        StarterKit.configure({ heading: false }),
        KeyboardShortcutHandler,
      ],
      content,
      editorProps: {
        attributes: {
          class: "w-full px-3 py-2 rounded bg-violet-900 text-white"
        },
      },
      onTransaction: () => {
        // force re-render so `tiptap.isActive` works as expected
        tiptap = tiptap;
      },
      onUpdate: (context) => {
        content = context.editor.getJSON();
      }
    });
  });

  onDestroy(() => {
    if (tiptap) tiptap.destroy();
  });
</script>

<div bind:this={element}></div>