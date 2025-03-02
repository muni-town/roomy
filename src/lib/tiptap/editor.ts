import { mount, unmount } from "svelte";
import { keymap } from "@tiptap/pm/keymap";
import StarterKit from "@tiptap/starter-kit";
import { PluginKey } from "@tiptap/pm/state";
import Mention from "@tiptap/extension-mention";
import { renderMarkdownSanitized } from "$lib/markdown";
import SuggestionSelect from "$lib/components/SuggestionSelect.svelte";
import { Extension, generateHTML, getSchema, mergeAttributes } from "@tiptap/core";
import type { SuggestionKeyDownProps, SuggestionProps } from "@tiptap/suggestion";

/* Keyboard Shortcuts: used to add and override existing shortcuts */
type KeyboardShortcutHandlerProps = {
  onEnter: () => void;
};

export const initKeyboardShortcutHandler = ({ onEnter }: KeyboardShortcutHandlerProps) => 
  Extension.create({ 
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
    },
  }
}

type UserMentionProps = { users: Item[] };
const UserMentionExtension = Mention.extend({ 
  name: "userMention",
  // Used by `generateHTML`
  renderHTML({ HTMLAttributes, node }) {
    return [
      "a",
      mergeAttributes(
        { 
          href: `https://bsky.app/profile/${node.attrs.id}`,
          class: "user-mention !no-underline" 
        }, 
        HTMLAttributes
      ),
      `@${node.attrs.label}`
    ]
  }
});
export const initUserMention = ({ users }: UserMentionProps) => 
  UserMentionExtension.configure({
    HTMLAttributes: { class: "user-mention" },
    suggestion: suggestion({ items: users, char: "@", pluginKey: "userMention" }),
  });

// TODO: might need to combine with channel mentions since
// we want to trigger both with "#"
type ThreadMentionProps = { threads: Item[] };
const ThreadMentionExtension = Mention.extend({ 
  name: "threadMention",
  // Used by `generateHTML`
  renderHTML({ HTMLAttributes, node }) {
    const { ulid, space } = JSON.parse(node.attrs.id);
    return [
      "a",
      mergeAttributes(
        { 
          href: `/space/${space}/thread/${ulid}`,
          class: "thread-mention !no-underline" 
        }, 
        HTMLAttributes
      ),
      `@${node.attrs.label}`
    ]
  }
});
export const initThreadMention = ({ threads }: ThreadMentionProps) => 
  ThreadMentionExtension.configure({
    HTMLAttributes: { class: "thread-mention" },
    suggestion: suggestion({ items: threads, char: "~", pluginKey: "threadMention" })
  });


/* Utilities */
export const extensions = [
  StarterKit.configure({ heading: false }),
  UserMentionExtension,
  ThreadMentionExtension
];

export const editorSchema = getSchema(extensions);

export function getContentHtml(content: string) {
  try {
    const data = JSON.parse(content);
    return generateHTML(data, extensions);
  }
  catch {
    return renderMarkdownSanitized(content);
  }
}
