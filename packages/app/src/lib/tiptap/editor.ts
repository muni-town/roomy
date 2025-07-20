import { mount, unmount } from "svelte";
import { keymap } from "@tiptap/pm/keymap";
import { PluginKey } from "@tiptap/pm/state";
import Mention from "@tiptap/extension-mention";
import SuggestionSelect from "$lib/components/SuggestionSelect.svelte";
import { Extension, mergeAttributes } from "@tiptap/core";
import type {
  SuggestionKeyDownProps,
  SuggestionProps,
} from "@tiptap/suggestion";

/* Keyboard Shortcuts: used to add and override existing shortcuts */
type KeyboardShortcutHandlerProps = {
  onEnter: () => void;
};

export const initKeyboardShortcutHandler = ({
  onEnter,
}: KeyboardShortcutHandlerProps) =>
  Extension.create({
    name: "keyboardShortcutHandler",
    addProseMirrorPlugins() {
      return [
        keymap({
          Enter: () => {
            onEnter();
            this.editor.commands.clearContent();
            return true;
          },
        }),
      ];
    },
  });

/* Mention Extensions */
export interface Item {
  value: string;
  label: string;
  disabled?: boolean;
  [x: string]: unknown;
}

// Generic suggestion utility object for the Mention extension
function suggestion({
  items,
  char,
  pluginKey,
}: {
  items: Item[];
  char: string;
  pluginKey: string;
}) {
  const fuzzyMatch = (text: string, query: string): boolean => {
    if (!query) return true;

    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase();

    let textIndex = 0;
    let queryIndex = 0;

    while (textIndex < lowerText.length && queryIndex < lowerQuery.length) {
      if (lowerText[textIndex] === lowerQuery[queryIndex]) {
        queryIndex++;
      }
      textIndex++;
    }

    return queryIndex === lowerQuery.length;
  };

  return {
    char,
    pluginKey: new PluginKey(pluginKey),
    items: ({ query }: { query: string }) => {
      return items.filter((item) => fuzzyMatch(item.label, query)).slice(0, 5);
    },
    render: () => {
      let wrapper: HTMLDivElement;
      let component: ReturnType<typeof SuggestionSelect>;

      return {
        onStart: (props: SuggestionProps) => {
          wrapper = document.createElement("div");
          props.editor.view.dom.parentNode?.appendChild(wrapper);

          component = mount(SuggestionSelect, {
            target: wrapper,
            props: {
              items: props.items,
              callback: ({ id, label }: { id: string; label: string }) =>
                props.command({ id, label }),
            },
          });
        },
        onUpdate: (props: SuggestionProps) => {
          component.setItems(props.items);
        },
        onKeyDown: (props: SuggestionKeyDownProps) => {
          return component.onKeyDown(props.event);
        },
        onExit: () => {
          unmount(component);
        },
      };
    },
  };
}

type UserMentionProps = { users: Item[] };
const UserMentionExtension = Mention.extend({
  name: "userMention",
  // Used by `generateHTML`
  renderHTML({ HTMLAttributes, node }) {
    console.log("attrs", node.attrs);
    return [
      "a",
      mergeAttributes(
        {
          href: `/user/${node.attrs.id}`,
          class: "mention !no-underline",
        },
        HTMLAttributes,
      ),
      `@${node.attrs.label}`,
    ];
  },
});
export const initUserMention = ({ users }: UserMentionProps) =>
  UserMentionExtension.configure({
    HTMLAttributes: { class: "mention" },
    suggestion: suggestion({
      items: users,
      char: "@",
      pluginKey: "userMention",
    }),
  });

// 'Space Context': channels, threads
type SpaceContextMentionProps = { context: Item[] };
const SpaceContextMentionExtension = Mention.extend({
  name: "channelThreadMention",
  // Used by `generateHTML`
  renderHTML({ HTMLAttributes, node }) {
    const { id, space, type } = JSON.parse(node.attrs.id);
    return [
      "a",
      mergeAttributes(
        {
          href: `/${space}/${id}`,
          class: `mention ${type === "thread" ? "thread-mention" : "channel-mention"} !no-underline`,
        },
        HTMLAttributes,
      ),
      node.attrs.label,
    ];
  },
});
export const initSpaceContextMention = ({
  context,
}: SpaceContextMentionProps) =>
  SpaceContextMentionExtension.configure({
    HTMLAttributes: { class: "mention" },
    suggestion: suggestion({
      items: context,
      char: "#",
      pluginKey: "spaceContextMention",
    }),
    renderHTML({ options, node }) {
      const { type } = JSON.parse(node.attrs.id);
      return [
        "span",
        mergeAttributes(
          {
            class: `mention ${type === "thread" ? "thread-mention" : "channel-mention"} !no-underline`,
          },
          options.HTMLAttributes,
        ),
        node.attrs.label,
      ];
    },
  });
