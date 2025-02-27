<script lang="ts">
  import { onMount, mount, unmount, onDestroy } from "svelte";
  import { Editor, Extension } from "@tiptap/core";
  import { keymap } from "@tiptap/pm/keymap";
  import StarterKit from "@tiptap/starter-kit";
  import Mention from "@tiptap/extension-mention";
  import SuggestionSelect from "./SuggestionSelect.svelte";
  import type { SuggestionKeyDownProps, SuggestionProps } from "@tiptap/suggestion";
  import { PluginKey } from "@tiptap/pm/state";

  let { content = $bindable({}) } = $props();
  let element: HTMLDivElement | undefined = $state();
  let tiptap: Editor | undefined = $state();

  // TODO: get users from context
  const users = [
    { value: "zeu.dev", label: "zeu.dev" },
    { value: "test.zeu.dev", label: "test.zeu.dev" }
  ];

  // TODO: get threads from context
  const threads = [
    { value: "id1", label: "bug fix" },
    { value: "id2", label: "feature idea" }
  ];

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
  function suggestion({ items, char, pluginKey }: { items: Item[], char: string, pluginKey: string }) {
    return {
      char,
      pluginKey: new PluginKey(pluginKey),
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
                callback: ({ id, label }: { id: string, label: string }) => props.command({ id, label }) 
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
      HTMLAttributes: { class: "user-mention" },
      suggestion: suggestion({ items: users, char: "@", pluginKey: "userMention" })
    });

  // Thread Mentions
  // TODO: might need to combine with channel mentions since
  // we want to trigger both with "#"
  const ThreadMention = Mention
    .extend({ name: "threadMention" })
    .configure({
      HTMLAttributes: { class: "thread-mention" },
      suggestion: suggestion({ items: threads, char: "~", pluginKey: "threadMention" })
    });

  onMount(() => {
    tiptap = new Editor({
      element,
      extensions: [
        StarterKit.configure({ heading: false }),
        KeyboardShortcutHandler,
        UserMention,
        ThreadMention
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