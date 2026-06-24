import { mount, unmount } from "svelte";
import { keymap } from "@tiptap/pm/keymap";
import { PluginKey } from "@tiptap/pm/state";
import Mention from "@tiptap/extension-mention";
import SuggestionSelect from "@roomy/design/components/helper/SuggestionSelect.svelte";
import UserMentionList from "./UserMentionList.svelte";
import type { TypeaheadUser } from "@roomy/design/components/ui/user-typeahead/UserTypeahead.svelte";
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
          wrapper.classList.add("text-base-900", "dark:text-base-100");

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

type UserMentionProps = { search: (query: string) => Promise<TypeaheadUser[]> };
const UserMentionExtension = Mention.extend({
  name: "userMention",
  // Used by `generateHTML`
  renderHTML({ HTMLAttributes, node }) {
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

/**
 * Suggestion config for `@user` mentions. Unlike the generic `suggestion()`
 * helper (which filters a static list), this drives a **server-side** search
 * from the render lifecycle: the editor owns the query text, and we debounce
 * `search(query)` ourselves with a monotonic request id so stale responses are
 * discarded — the same pattern `UserTypeahead` uses. Results render in a
 * floating box above the input via `UserMentionList`, which reuses the shared
 * `UserTypeaheadList` rows.
 */
function userSuggestion({
  search,
  pluginKey,
}: {
  search: (query: string) => Promise<TypeaheadUser[]>;
  pluginKey: string;
}) {
  return {
    char: "@",
    pluginKey: new PluginKey(pluginKey),
    // Results are driven from `render`; TipTap only needs an items source to
    // decide when to open the popup, so return an empty array.
    items: () => [],
    render: () => {
      let wrapper: HTMLDivElement;
      let component: ReturnType<typeof UserMentionList>;
      let reqId = 0;
      let timer: ReturnType<typeof setTimeout>;
      /**
       * The suggestion `command` is bound to a specific range (the `@query`
       * span) at the moment the Suggestion plugin builds the props. Each
       * `onUpdate` delivers a fresh `command` bound to the latest range, so we
       * keep the newest one here and invoke it from the list's `callback` —
       * otherwise selecting a mention would use the stale `onStart` range
       * (just `@`) and leave the typed query (e.g. "erl") behind in the editor.
       */
      let latestCommand:
        | ((p: { id: string; label: string }) => void)
        | undefined;

      const displayName = (u: TypeaheadUser) => u.name || u.handle || u.did;

      const run = (query: string) => {
        clearTimeout(timer);
        const myReq = ++reqId;
        const q = query.trim();
        const isEmpty = q === "";
        // Empty query → the fetcher returns most-recently-active members from
        // the cached `getMessages` result (no debounce, no spinner). Non-empty
        // → debounced server search.
        component.setEmptyMessage(
          isEmpty ? "No recent members in this room" : "No matching members",
        );
        if (!isEmpty) component.setLoading(true);
        timer = setTimeout(
          async () => {
            try {
              const res = await search(q);
              if (myReq !== reqId) return; // a newer keystroke superseded this one
              component.setItems(res);
            } catch {
              if (myReq === reqId) component.setItems([]);
            } finally {
              if (myReq === reqId) component.setLoading(false);
            }
          },
          isEmpty ? 0 : 200,
        );
      };

      return {
        onStart: (props: SuggestionProps) => {
          latestCommand = props.command;
          wrapper = document.createElement("div");
          // Float above the input. The editor's parent (`#chat-input`) is
          // `position: relative`, so `bottom-full` anchors us just above it.
          wrapper.className =
            "absolute bottom-full mb-1 left-0 right-0 z-30 text-base-900 dark:text-base-100";
          props.editor.view.dom.parentNode?.appendChild(wrapper);
          component = mount(UserMentionList, {
            target: wrapper,
            props: {
              callback: (user: TypeaheadUser) =>
                latestCommand?.({ id: user.did, label: displayName(user) }),
            },
          });
          run(props.query);
        },
        onUpdate: (props: SuggestionProps) => {
          latestCommand = props.command;
          run(props.query);
        },
        onKeyDown: (props: SuggestionKeyDownProps) => {
          return component.onKeyDown(props.event);
        },
        onExit: () => {
          clearTimeout(timer);
          reqId++;
          unmount(component);
          wrapper.remove();
        },
      };
    },
  };
}

export const initUserMention = ({ search }: UserMentionProps) =>
  UserMentionExtension.configure({
    HTMLAttributes: { class: "mention" },
    suggestion: userSuggestion({ search, pluginKey: "userMention" }),
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
          class: `mention ${type === "space.roomy.thread" ? "thread-mention" : "channel-mention"} !no-underline`,
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
            class: `mention ${type === "space.roomy.thread" ? "thread-mention" : "channel-mention"} !no-underline`,
          },
          options.HTMLAttributes,
        ),
        node.attrs.label,
      ];
    },
  });
