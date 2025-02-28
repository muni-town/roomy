import { mount, unmount } from "svelte";
import { keymap } from "@tiptap/pm/keymap";
import StarterKit from "@tiptap/starter-kit";
import { PluginKey } from "@tiptap/pm/state";
import Mention from "@tiptap/extension-mention";
import { Editor, Extension, getSchema } from "@tiptap/core";
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
const UserMentionExtension = Mention.extend({ name: "userMention" });
const initUserMention = ({ users }: UserMentionProps) => 
  UserMentionExtension.configure({
    HTMLAttributes: { class: "user-mention" },
    suggestion: suggestion({ items: users, char: "@", pluginKey: "userMention" })
  });

// TODO: might need to combine with channel mentions since
// we want to trigger both with "#"
type ThreadMentionProps = { threads: Item[] };
const ThreadMentionExtension = Mention.extend({ name: "threadMention" });
const initThreadMention = ({ threads }: ThreadMentionProps) => 
  ThreadMentionExtension.configure({
    HTMLAttributes: { class: "thread-mention" },
    suggestion: suggestion({ items: threads, char: "~", pluginKey: "threadMention" })
  });


/* Tiptap Editor Instance */

export const editorSchema = getSchema([
  StarterKit.configure({ heading: false }),
  UserMentionExtension,
  ThreadMentionExtension
]);

type CreateTiptapInstanceProps = {
  element: HTMLElement;
  content: Record<any, any>;
}
& KeyboardShortcutHandlerProps
& UserMentionProps
& ThreadMentionProps;

export function createTiptapInstance({
  element,
  content,
  onEnter,
  users,
  threads
}: CreateTiptapInstanceProps) {
  const extensions = [
    StarterKit.configure({ heading: false }),
    initKeyboardShortcutHandler({ onEnter }),
    initUserMention({ users }),
    initThreadMention({ threads })
  ];

  const instance = new Editor({
    element,
    extensions,
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

  return instance;
}