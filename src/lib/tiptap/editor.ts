import { mount, unmount } from "svelte";
import { keymap } from "@tiptap/pm/keymap";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
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
import type { Editor } from "@tiptap/core";
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
export const extensions = [StarterKit.configure({ heading: false }), Image];

// Base extensions without mention plugins
export const baseExtensions = [...extensions];

// Create a complete set of extensions including the mention extensions
// This is used when we don't need to configure mentions with specific users/context
export const completeExtensions = [
  ...baseExtensions,
  UserMentionExtension.configure({
    HTMLAttributes: { class: "mention" },
  }),
  SpaceContextMentionExtension.configure({
    HTMLAttributes: { class: "mention" },
  }),
];

// Function to create complete extensions with configured mention plugins
export function createCompleteExtensions({
  users = [],
  context = [],
  includeImage = true,
}: {
  users?: Item[];
  context?: Item[];
  includeImage?: boolean;
}) {
  // Use any[] to avoid TypeScript compatibility issues
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: any[] = [];

  // Add all base extensions except image
  for (const ext of baseExtensions.filter((ext) => ext.name !== "image")) {
    result.push(ext);
  }

  // Only add the Image extension if includeImage is true
  if (includeImage) {
    result.push(
      Image.configure({
        HTMLAttributes: {
          class: "max-w-[300px] max-h-[300px] object-contain relative",
        },
      }),
    );
  }

  // Add mention extensions
  result.push(
    UserMentionExtension.configure({
      HTMLAttributes: { class: "mention" },
      suggestion: suggestion({
        items: users,
        char: "@",
        pluginKey: "userMention",
      }),
    }),
  );

  result.push(
    SpaceContextMentionExtension.configure({
      HTMLAttributes: { class: "mention" },
      suggestion: suggestion({
        items: context,
        char: "#",
        pluginKey: "spaceContextMention",
      }),
    }),
  );

  return result;
}

export const editorSchema = getSchema(extensions);

export function getContentHtml(content: JSONContent) {
  try {
    // Check if content is empty or invalid
    if (
      !content ||
      typeof content !== "object" ||
      Object.keys(content).length === 0
    ) {
      return ""; // Return empty string for empty content
    }

    // Ensure content has the required structure for TipTap
    const validContent = !content.type ? { type: "doc", content: [] } : content;

    // Generate HTML from the content using TipTap with complete extensions
    // to ensure all node types (including mentions) are properly rendered
    // We use the default completeExtensions here since we don't need user/context data for rendering
    const html = generateHTML(validContent, completeExtensions);

    // Check if the content contains an image node
    const hasImageNode = content.content?.some((node) => node.type === "image");

    // If there's an image, don't convert URLs to links to prevent breaking image src attributes
    if (hasImageNode) {
      return html;
    }

    // Convert any URLs in the HTML to clickable links
    // TODO: Handle links in the rich text editor instead.
    // In the long term we want to handle creating links in the rich text
    // editor and remove this post-processing step.
    return convertUrlsToLinks(html);
  } catch (e) {
    console.error("Error generating HTML", e, "Content", content);
    // Return empty string instead of throwing to prevent UI crashes
    return "";
  }
}

export async function handleImageUpload(
  editor: Editor,
  file: File,
  uploadFn: (file: File) => Promise<{ url: string }>,
) {
  // Insert a loading placeholder
  editor
    .chain()
    .focus()
    .insertContent({
      type: "image",
      attrs: {
        src: "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzAwIiBoZWlnaHQ9IjMwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSIjZjBmMGYwIi8+PGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMTUwLCAxNTApIj48Y2lyY2xlIHI9IjMwIiBmaWxsPSJ0cmFuc3BhcmVudCIgc3Ryb2tlPSIjNjM2M2ZmIiBzdHJva2Utd2lkdGg9IjgiIHN0cm9rZS1kYXNoYXJyYXk9IjE4OC41IiBzdHJva2UtZGFzaG9mZnNldD0iMCI+PGFuaW1hdGVUcmFuc2Zvcm0gYXR0cmlidXRlTmFtZT0idHJhbnNmb3JtIiB0eXBlPSJyb3RhdGUiIHJlcGVhdENvdW50PSJpbmRlZmluaXRlIiBkdXI9IjFzIiB2YWx1ZXM9IjAgMCAwOzM2MCAwIDAiIGtleVRpbWVzPSIwOzEiPjwvYW5pbWF0ZVRyYW5zZm9ybT48L2NpcmNsZT48L2c+PHRleHQgeD0iNTAlIiB5PSI1MCUiIGZvbnQtZmFtaWx5PSJBcmlhbCIgZm9udC1zaXplPSIyMCIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZG9taW5hbnQtYmFzZWxpbmU9Im1pZGRsZSIgZmlsbD0iIzYzNjNmZiI+VXBsb2FkaW5nIGltYWdlLi4uPC90ZXh0Pjwvc3ZnPg==",
        alt: "Uploading image...",
        "data-loading": "true",
      },
    })
    .run();

  // Upload the image
  return uploadFn(file)
    .then((result) => {
      // Find and replace the loading placeholder with the actual image
      const transaction = editor.state.tr;
      let placeholderFound = false;

      editor.state.doc.descendants((node, pos) => {
        if (
          node.type.name === "image" &&
          node.attrs["data-loading"] === "true"
        ) {
          transaction.setNodeMarkup(pos, undefined, {
            ...node.attrs,
            src: result.url,
            alt: "User uploaded image",
            "data-loading": null,
          });
          placeholderFound = true;
          return false; // Stop traversal once we find the placeholder
        }
        return true;
      });

      if (placeholderFound) {
        editor.view.dispatch(transaction);
      } else {
        // If placeholder not found (rare case), insert the image directly
        editor
          .chain()
          .focus()
          .insertContent({
            type: "image",
            attrs: {
              src: result.url,
              alt: "User uploaded image",
            },
          })
          .run();
      }

      return result;
    })
    .catch((error) => {
      // Remove the loading placeholder on error
      const transaction = editor.state.tr;
      editor.state.doc.descendants((node, pos) => {
        if (
          node.type.name === "image" &&
          node.attrs["data-loading"] === "true"
        ) {
          transaction.delete(pos, pos + node.nodeSize);
          return false;
        }
        return true;
      });
      editor.view.dispatch(transaction);
      throw error; // Re-throw to allow caller to handle the error
    });
}
