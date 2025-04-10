import { mount, unmount } from "svelte";
import { keymap } from "@tiptap/pm/keymap";
import StarterKit from "@tiptap/starter-kit";
import { PluginKey } from "@tiptap/pm/state";
import Mention from "@tiptap/extension-mention";
import SuggestionSelect from "$lib/components/SuggestionSelect.svelte";
import {
  Extension,
  generateHTML,
  getSchema,
  mergeAttributes,
  type JSONContent,
} from "@tiptap/core";
import type {
  SuggestionKeyDownProps,
  SuggestionProps,
} from "@tiptap/suggestion";
import { convertUrlsToLinks } from "$lib/urlUtils";


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
  return {
    char,
    pluginKey: new PluginKey(pluginKey),
    items: ({ query }: { query: string }) => {
      return items
        .filter((item) =>
          item.label.toLowerCase().startsWith(query.toLowerCase()),
        )
        .slice(0, 5);
    },
    render: () => {
      let wrapper: HTMLElement | undefined;
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
    return [
      "a",
      mergeAttributes(
        {
          href: `https://${node.attrs.label}`,
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
          href:
            type === "thread" ? `/${space}/thread/${id}` : `/${space}/${id}`,
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

/* Utilities */
export const extensions = [
  StarterKit.configure({ heading: false }),
  UserMentionExtension,
  SpaceContextMentionExtension,
];

export const editorSchema = getSchema(extensions);

// Import the CustomImage from image-extension to avoid duplication
import { CustomImage } from "./image-extension";

export function getContentHtml(content: JSONContent) {
  // Define a type for node objects in the content tree
  type ContentNode = {
    type?: string;
    content?: ContentNode[];
    [key: string]: unknown;
  };

  function sanitizeContent(node: ContentNode | null | undefined): ContentNode | null {
    // Handle null, undefined, or non-object values
    if (!node || typeof node !== 'object') return null;

    // Handle arrays (like content arrays)
    if (Array.isArray(node)) {
      const filtered = node
        .map((item) => sanitizeContent(item as ContentNode))
        .filter((child): child is ContentNode => child !== null);
      return filtered.length > 0 ? filtered as unknown as ContentNode : null;
    }

    // Skip nodes with undefined type
    if (node.type === undefined) {
      return null;
    }

    // Process node content recursively
    if (node.content && Array.isArray(node.content)) {
      node.content = node.content
        .map((item) => sanitizeContent(item))
        .filter((child): child is ContentNode => child !== null);
    }

    return node;
  }

  try {
    // Create a deep copy of the content to avoid modifying the original
    const contentCopy = JSON.parse(JSON.stringify(content));
    // Sanitize the content to remove invalid nodes
    const sanitizedContent = sanitizeContent(contentCopy);

    // If sanitization removed everything, return empty string
    if (!sanitizedContent) return '';

    // Include all extensions including CustomImage
    const renderExtensions = [
      ...extensions,
      CustomImage,
    ];

    // Generate HTML from the sanitized content using TipTap
    const html = generateHTML(sanitizedContent, renderExtensions);

    // Convert any URLs in the HTML to clickable links
    // TODO: Handle links in the rich text editor instead.
    // In the long term we want to handle creating links in the rich text
    // editor and remove this post-processing step.
    return convertUrlsToLinks(html);
  } catch (e) {
    console.error("Error in primary rendering:", e, "Content:", content);

    try {
      if (content && typeof content === 'object') {
        // Create a safe copy for the fallback attempt
        const safeCopy = JSON.parse(JSON.stringify(content));

        // Remove image nodes which might be causing issues
        if (safeCopy.content && Array.isArray(safeCopy.content)) {
          safeCopy.content = safeCopy.content.filter((node: Record<string, unknown>) => {
            return node && typeof node === 'object' && node.type !== undefined && node.type !== 'image';
          });
        }

        // Make sure we include all extensions in the fallback attempt too
        const fallbackExtensions = [
          ...extensions,
          CustomImage,
        ];

        return generateHTML(safeCopy, fallbackExtensions);
      }
    } catch (fallbackError) {
      console.error("Fallback rendering also failed:", fallbackError);
    }

    // Return empty string if all rendering attempts fail
    return '';
  }
}
