import { mount, unmount } from "svelte";
import { keymap } from "@tiptap/pm/keymap";
import StarterKit from "@tiptap/starter-kit";
import { PluginKey } from "@tiptap/pm/state";
import Mention from "@tiptap/extension-mention";
import { Editor, Extension } from "@tiptap/core";
import SuggestionSelect from "$lib/components/SuggestionSelect.svelte";
import type { SuggestionKeyDownProps, SuggestionProps } from "@tiptap/suggestion";

/* Keyboard Shortcuts: used to add and override existing shortcuts */
type KeyboardShortcutHandlerProps = {
  onEnter: () => void;
};

const initKeyboardShortcutHandler = ({ onEnter }: KeyboardShortcutHandlerProps) => Extension.create({ 
  name: "keyboardShortcutHandler", 
  addProseMirrorPlugins() { 
    return [
      keymap({ 
        "Enter": () => {
          onEnter();
          this.editor.commands.clearContent();
          return true;
        }
      }),
    ]
  }
});

/* Mention Extensions */
export interface Item {
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

type UserMentionProps = { users: Item[] };
const initUserMention = ({ users }: UserMentionProps) => Mention
  .extend({ name: "userMention" })
  .configure({
    HTMLAttributes: { class: "user-mention" },
    suggestion: suggestion({ items: users, char: "@", pluginKey: "userMention" })
  });

// TODO: might need to combine with channel mentions since
// we want to trigger both with "#"
type ThreadMentionProps = { threads: Item[] };
const initThreadMention = ({ threads }: ThreadMentionProps) => Mention
  .extend({ name: "threadMention" })
  .configure({
    HTMLAttributes: { class: "thread-mention" },
    suggestion: suggestion({ items: threads, char: "~", pluginKey: "threadMention" })
  });


/* Tiptap Editor Instance */

type CreateTiptapInstanceProps = {
  element: HTMLElement;
  content: Record<any, any>;
}
& Partial<KeyboardShortcutHandlerProps>
& Partial<UserMentionProps>
& Partial<ThreadMentionProps>;

export function createTiptapInstance({
  element,
  content,
  onEnter,
  users,
  threads
}: CreateTiptapInstanceProps) {
  return new Editor({
    element,
    extensions: [
      StarterKit.configure({ heading: false }),
      ...(onEnter ? [initKeyboardShortcutHandler({ onEnter })] : []),
      ...(users ? [initUserMention({ users })] : []),
      ...(threads ? [initThreadMention({ threads })] : []),
    ],
    content,
    editorProps: {
      attributes: {
        class: "w-full px-3 py-2 rounded bg-violet-900 text-white"
      },
    },
    onUpdate: (context) => {
      content = context.editor.getJSON();
    }
  });
}