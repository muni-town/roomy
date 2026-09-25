import { Extension } from "@tiptap/core";
import { keymap } from "@tiptap/pm/keymap";
import { splitBlock } from "@tiptap/pm/commands";

/* Keyboard Shortcuts: adds and overrides existing shortcuts */
export type KeyboardShortcutHandlerProps = {
  onEnter: () => void;
  /**
   * Whether bare Enter sends the message (chat convention), or inserts a new
   * block for a composer that submits through its Send button instead.
   *
   * A getter is consulted at keypress time rather than frozen when the editor
   * is built: the chat composer's answer follows the input device (a
   * touch-primary device has no Shift/Cmd key to reach the newline binding
   * with), so it must be able to change without rebuilding the editor — or
   * reloading the page.
   */
  sendOnEnter?: boolean | (() => boolean);
};

export const initKeyboardShortcutHandler = ({
  onEnter,
  sendOnEnter = true,
}: KeyboardShortcutHandlerProps) => {
  const shouldSendOnEnter =
    typeof sendOnEnter === "function" ? sendOnEnter : () => sendOnEnter;

  return Extension.create({
    name: "keyboardShortcutHandler",
    // Higher than StarterKit's default (100) so this keymap runs before the
    // HardBreak extension's `Shift-Enter`/`Mod-Enter` → setHardBreak bindings,
    // letting us override them with splitListItem/splitBlock (new block).
    priority: 1000,
    addProseMirrorPlugins() {
      return [
        keymap({
          // Bare Enter sends the message (chat convention). In composer mode
          // it instead splits the block (new paragraph/list item).
          Enter: (state, dispatch) => {
            if (shouldSendOnEnter()) {
              onEnter();
              return true;
            }
            if (!this.editor.commands.splitListItem("listItem")) {
              splitBlock(state, dispatch);
            }
            return true;
          },
          // Shift/Cmd+Enter create a new block. In a list this means a new
          // list item (splitListItem); elsewhere a new paragraph (splitBlock).
          // This lets users build lists and stack multiple headers in one
          // message without sending.
          "Shift-Enter": (state, dispatch) => {
            if (!this.editor.commands.splitListItem("listItem")) {
              splitBlock(state, dispatch);
            }
            return true;
          },
          "Mod-Enter": (state, dispatch) => {
            if (!this.editor.commands.splitListItem("listItem")) {
              splitBlock(state, dispatch);
            }
            return true;
          },
        }),
      ];
    },
  });
};
