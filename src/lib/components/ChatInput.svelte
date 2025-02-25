<script lang="ts">
  import { onMount, mount, unmount } from "svelte";
  import { Extension } from "@tiptap/core";
  import { keymap } from "@tiptap/pm/keymap";
  import StarterKit from "@tiptap/starter-kit";
  import Mention from "@tiptap/extension-mention";
  import { createEditor, Editor, EditorContent, SvelteRenderer } from "svelte-tiptap";
  import type { Readable } from "svelte/store";
  import type { SuggestionKeyDownProps, SuggestionProps } from "@tiptap/suggestion";
  import SuggestionSelect from "./SuggestionSelect.svelte";

  let { content = $bindable({}) } = $props();
  let tiptap: Readable<Editor>;

  const users = [
    { handle: "zeu.dev" },
    { handle: "test.zeu.dev" }
  ];

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
    tiptap = createEditor({
      extensions: [
        StarterKit.configure({ heading: false }),
        KeyboardShortcutHandler,
        Mention.configure({
          HTMLAttributes: { class: "mention" },
          suggestion: suggestion()
        })
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

  function suggestion() {
    return {
      items: ({ query }: { query: string }) => {
        return users.filter((user) => user.handle.toLowerCase().startsWith(query.toLowerCase())).slice(0,5);
      },
      render: () => {
        let wrapper;
        let component: ReturnType<typeof SuggestionSelect>;

        return {
          onStart: (props: SuggestionProps) => {
            wrapper = document.createElement("div");
            props.editor.view.dom.parentNode?.appendChild(wrapper);

            component = mount(SuggestionSelect, {
              target: wrapper,
              props: { items: props.items, callback: (item) => props.command({ id: item }) }
            }) as ReturnType<typeof SuggestionSelect>;
          },
          onUpdate: (props: SuggestionProps) => {
            component.setItems(props.items);
          },
          onkeydown: (props: SuggestionKeyDownProps) => { return component.onKeyDown(props.event); },
          onExit: () => {
            unmount(component);
          }
        }
      }
    }
  }
</script>

<EditorContent editor={$tiptap} />