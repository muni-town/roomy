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

  // TODO: get users from context
  const users = [
    { value: "zeu.dev", label: "zeu.dev" },
    { value: "test.zeu.dev", label: "test.zeu.dev" }
  ];

  // TODO: get threads from context


  // TODO: replace with automerge doc change submit function
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

  interface Item {
    value: string;
    label: string;
    disabled?: boolean;
    [x: string]: unknown;
  }

  // Generic suggestion utility object for the Mention extension
  function suggestion({ items, char }: { items: Item[], char: string }) {
    return {
      char,
      items: ({ query }: { query: string }) => {
        return items.filter((item) => 
          item.value.toLowerCase().startsWith(query.toLowerCase())
        ).slice(0,5);
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
                callback: (item) => props.command({ id: item }) 
              }
            }) as ReturnType<typeof SuggestionSelect>;
          },
          onUpdate: (props: SuggestionProps) => {
            component.setItems(props.items);
          },
          onKeyDown: (props: SuggestionKeyDownProps) => {
            return component.onKeyDown(props.event);
          },
          onExit: () => {
            unmount(component);
          }
        }
      }
    }
  }

  // User Mentions
  const UserMention = Mention
    .extend({ name: "userMention" })
    .configure({
      HTMLAttributes: { class: "mention" },
      suggestion: suggestion({ items: users, char: "@" })
    });

  onMount(() => {
    tiptap = new Editor({
      element,
      extensions: [
        StarterKit.configure({ heading: false }),
        KeyboardShortcutHandler,
        UserMention
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

</script>

<div bind:this={element}></div>