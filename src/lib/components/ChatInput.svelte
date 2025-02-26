<script lang="ts">
  import { onMount, mount, unmount, onDestroy } from "svelte";
  import { Editor, Extension } from "@tiptap/core";
  import { keymap } from "@tiptap/pm/keymap";
  import StarterKit from "@tiptap/starter-kit";
  import Mention from "@tiptap/extension-mention";
  import SuggestionSelect from "./SuggestionSelect.svelte";
  import type { SuggestionKeyDownProps, SuggestionProps } from "@tiptap/suggestion";

  let { content = $bindable({}) } = $props();
  let element: HTMLDivElement | undefined = $state();
  let tiptap: Editor | undefined = $state();

  const users = [
    { value: "zeu.dev", label: "zeu.dev" },
    { value: "test.zeu.dev", label: "test.zeu.dev" }
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
    tiptap = new Editor({
      element,
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

  onDestroy(() => { 
    tiptap?.destroy(); 
  });

  function suggestion() {
    return {
      items: ({ query }: { query: string }) => {
        return users.filter((user) => user.value.toLowerCase().startsWith(query.toLowerCase())).slice(0,5);
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
              props: { 
                items: props.items, 
                anchor: element!,
                callback: (item) => props.command({ id: item }) 
              }
            }) as ReturnType<typeof SuggestionSelect>;
          },
          onUpdate: (props: SuggestionProps) => {
            component.setItems(props.items);
          },
          onExit: () => {
            unmount(component);
          }
        }
      }
    }
  }
</script>

<div bind:this={element}></div>