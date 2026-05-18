/***
 * From Fox UI by Flo-bit
 * https://github.com/flo-bit/ui-kit/tree/main/packages/text/src/lib/components/rich-text-editor
 */

import { Extension } from "@tiptap/core";
import Suggestion from "@tiptap/suggestion";
import type { Editor, Range } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import type {
  SuggestionKeyDownProps,
  SuggestionProps,
} from "@tiptap/suggestion";
import SuggestionSelect from "./SuggestionSelect.svelte";
import { mount, unmount } from "svelte";
import tippy, { type GetReferenceClientRect } from "tippy.js";
import type { RichTextTypes } from "..";

export default Extension.create({
  name: "slash",

  addOptions() {
    return {
      suggestion: {
        char: "/",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        command: ({
          editor,
          range,
          props,
        }: {
          editor: Editor;
          range: Range;
          props: any;
        }) => {
          props.command({ editor, range });
        },
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        ...this.options.suggestion,
      }),
    ];
  },
});

export function suggestion({
  char,
  pluginKey,
  switchTo,
  processImageFile,
}: {
  char: string;
  pluginKey: string;
  switchTo: (value: RichTextTypes) => void;
  processImageFile: (file: File) => void;
}) {
  return {
    char,
    pluginKey: new PluginKey(pluginKey),

    items: ({ query }: { query: string }) => {
      return [
        {
          value: "paragraph",
          label: "Paragraph",
          command: ({ editor, range }: { editor: Editor; range: Range }) => {
            editor.chain().focus().deleteRange(range).run();
            switchTo("paragraph");
          },
        },
        {
          value: "heading-1",
          label: "Heading 1",
          command: ({ editor, range }: { editor: Editor; range: Range }) => {
            editor.chain().focus().deleteRange(range).run();
            switchTo("heading-1");
          },
        },
        {
          value: "heading-2",
          label: "Heading 2",
          command: ({ editor, range }: { editor: Editor; range: Range }) => {
            editor.chain().focus().deleteRange(range).run();
            switchTo("heading-2");
          },
        },
        {
          value: "heading-3",
          label: "Heading 3",
          command: ({ editor, range }: { editor: Editor; range: Range }) => {
            editor.chain().focus().deleteRange(range).run();
            switchTo("heading-3");
          },
        },
        {
          value: "blockquote",
          label: "Blockquote",
          command: ({ editor, range }: { editor: Editor; range: Range }) => {
            editor.chain().focus().deleteRange(range).run();
            switchTo("blockquote");
          },
        },
        {
          value: "code",
          label: "Code Block",
          command: ({ editor, range }: { editor: Editor; range: Range }) => {
            editor.chain().focus().deleteRange(range).run();
            switchTo("code");
          },
        },
        {
          value: "bullet-list",
          label: "Bullet List",
          command: ({ editor, range }: { editor: Editor; range: Range }) => {
            editor.chain().focus().deleteRange(range).run();
            switchTo("bullet-list");
          },
        },
        {
          value: "ordered-list",
          label: "Ordered List",
          command: ({ editor, range }: { editor: Editor; range: Range }) => {
            editor.chain().focus().deleteRange(range).run();
            switchTo("ordered-list");
          },
        },
        {
          value: "image",
          label: "Add Image",
          command: ({ editor, range }: { editor: Editor; range: Range }) => {
            editor.chain().focus().deleteRange(range).run();

            const fileInput = document.createElement("input");
            fileInput.type = "file";
            fileInput.click();
            fileInput.addEventListener("change", (event) => {
              const input = event.target as HTMLInputElement;
              if (!input.files?.length) return;
              const file = input.files[0];
              if (!file?.type.startsWith("image/")) return;
              processImageFile(file);

              input.remove();
            });
          },
        },
      ].filter((item) =>
        item.label.toLowerCase().includes(query.toLowerCase()),
      );
    },

    render: () => {
      let component: ReturnType<typeof SuggestionSelect>;
      let popup: ReturnType<typeof tippy>;

      return {
        onStart: (props: SuggestionProps) => {
          const element = document.createElement("div");

          component = mount(SuggestionSelect, {
            target: element,
            props,
          });

          if (!props.clientRect) {
            return;
          }

          popup = tippy("body", {
            getReferenceClientRect: props.clientRect as GetReferenceClientRect,
            appendTo: () => document.body,
            content: element,
            showOnCreate: true,
            interactive: true,
            trigger: "manual",
            placement: "bottom-start",
          });
        },
        onUpdate: (props: SuggestionProps) => {
          component.setItems(props.items);
          component.setRange(props.range);

          if (!props.clientRect) {
            return;
          }

          popup[0]?.setProps({
            getReferenceClientRect: props.clientRect as GetReferenceClientRect,
          });
        },
        onKeyDown: (props: SuggestionKeyDownProps) => {
          if (props.event.key === "Escape") {
            popup[0]?.hide();

            return true;
          }

          return component.onKeyDown(props.event);
        },
        onExit: () => {
          popup[0]?.destroy();
          unmount(component);
        },
      };
    },
  };
}
