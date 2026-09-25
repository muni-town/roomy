<script module lang="ts">
  let editor: Editor | undefined;
  export function setInputFocus() {
    if (!editor || editor.isDestroyed) return;
    editor.commands.focus();
  }
  export function clearInput() {
    if (!editor || editor.isDestroyed) return;
    editor.commands.clearContent();
  }
</script>

<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { Editor, Extension } from "@tiptap/core";
  import StarterKit from "@tiptap/starter-kit";
  import Placeholder from "@tiptap/extension-placeholder";
  import { type Item, initUserMention, initSpaceContextMention } from "$lib/tiptap/editor";
  import { initKeyboardShortcutHandler } from "$lib/tiptap/keyboardShortcut";
  import { extractMentionDids } from "$lib/tiptap/mentions";
  import { MediaQuery } from "svelte/reactivity";
  import { resolveSendOnEnter, TOUCH_PRIMARY_QUERY } from "$lib/input-device";
  import type { TypeaheadUser } from "@roomy/design/components/ui/user-typeahead/UserTypeahead.svelte";
  import { RichTextLink } from "$lib/tiptap/RichTextLink";
  import { cn } from "@roomy/design/utils";
  import { Markdown } from "tiptap-markdown";
  import { blocksToProseMirrorDoc, proseMirrorDocToBlocks } from "@roomy-space/sdk";
  import type { Block, ProseMirrorDoc, ProseMirrorMark, ProseMirrorNode } from "@roomy-space/sdk";

  type Props = {
    content: string;
    /**
     * Blocks+facets form of the editor content, kept in sync with `content`
     * on every update. The send path uses this when the composer produced
     * blocks; `content` (markdown) remains for the legacy path and for
     * messaging-state's string `input` binding.
     */
    blocks?: Block[];
    /**
     * DIDs of the users mentioned in the editor, kept in sync on every
     * update. The composer reads these itself on send; inline editors (e.g.
     * edit-message) bind this to surface the mentions to their save path —
     * legacy markdown messages carry mentions in the sidecar, not in blocks.
     */
    mentions?: string[];
    /**
     * The decoded blocks that seeded this editor — a rich-text message being
     * re-edited, or the per-room composer document being recalled on return.
     * When present, the editor initializes from
     * `blocksToProseMirrorDoc(initialBlocks)` instead of the markdown
     * `content` string, so structured messages open as their decoded text
     * (not the base64-encoded wire body) and stay rich-text on save. For the
     * composer this keeps stored mentions re-rendering as chips.
     */
    initialBlocks?: Block[];
    /** Server-search fetcher for `@user` mentions (hits `getMembers?search=`). */
    mentionSearch?: (query: string) => Promise<TypeaheadUser[]>;
    /** Rooms in space that can be mentioned with #room */
    context?: Item[];
    onEnter: (content: string, mentions: string[], blocks: Block[]) => Promise<void>;
    placeholder?: string;
    setFocus?: boolean;
    disabled?: boolean;
    processImageFile?: (file: File) => void;
    /**
     * Whether this is the main composer. Only the composer registers itself
     * as the module-level `editor` that `clearInput()`/`setInputFocus()`
     * target. Inline editors (e.g. the edit-message editor) must leave this
     * false so they don't hijack the composer's clear/focus.
     */
    composer?: boolean;
    /**
     * Explicit override for bare Enter: true sends, false inserts a new block.
     *
     * Omitted (the usual case) → the input device decides, so a touch device
     * keeps Return for newlines while a hardware keyboard keeps Enter-to-send.
     * `resolveSendOnEnter` is the whole rule.
     */
    sendOnEnter?: boolean;
  };

  let {
    content = $bindable(""),
    blocks = $bindable(),
    mentions = $bindable(),
    initialBlocks,
    mentionSearch,
    context,
    onEnter,
    placeholder = "Write something ...",
    setFocus = false,
    disabled = false,
    processImageFile,
    composer = false,
    sendOnEnter,
  }: Props = $props();

  let element: HTMLDivElement | undefined = $state();

  let tiptap: Editor | undefined = $state();

  /**
   * The live touch-primary signal. `MediaQuery.current` re-reads
   * `matchMedia`, and the shortcut handler reads this per keypress, so a
   * tablet that grows a keyboard cover — or any pointer-capability change —
   * changes what bare Enter does without rebuilding the editor or reloading.
   */
  const pointerCoarse = new MediaQuery(TOUCH_PRIMARY_QUERY);

  function flushTrailingAutolink() {
    if (!tiptap || !tiptap.state.selection.empty) return;

    const from = tiptap.state.selection.$from;
    if (from.parentOffset !== from.parent.content.size) return;

    const boundary = tiptap.state.selection.from;
    tiptap.view.dispatch(tiptap.state.tr.insertText(" "));
    return boundary;
  }

  async function wrappedOnEnter() {
    const boundary = flushTrailingAutolink();
    const mentions = tiptap ? extractMentionDids(tiptap) : [];
    const currentBlocks = tiptap ? proseMirrorDocToBlocks(tiptap.getJSON()) : (blocks ?? []);
    if (boundary !== undefined) {
      tiptap?.commands.deleteRange({ from: boundary, to: boundary + 1 });
    }
    await onEnter(content, mentions, currentBlocks);
  }

  /**
   * Submit the editor's current content, exactly as the Enter key does.
   *
   * The composer's Send button calls this instead of going through its own
   * path: the two entry points must produce byte-identical bodies, including
   * the trailing-autolink flush that `wrappedOnEnter` performs before
   * serializing. Any second entry point that serializes independently
   * reintroduces the divergence this exists to prevent.
   */
  export async function submit() {
    if (disabled) return;
    await wrappedOnEnter();
  }

  /**
   * The editor's current content as blocks+facets, flushed the same way a
   * submit would flush it (trailing autolink committed first).
   *
   * Callers that build their own message (e.g. the forward modal, which
   * sends one commentary body to several rooms) must read the body through
   * this rather than the `blocks` binding, which stays `undefined` until the
   * first edit.
   */
  export function getBlocks(): Block[] {
    flushTrailingAutolink();
    return tiptap ? proseMirrorDocToBlocks(tiptap.getJSON()) : (blocks ?? []);
  }

  /**
   * When re-editing a rich-text message, `blocksToProseMirrorDoc` reconstructs
   * `#didMention` / `#roomRef` facets as `userMention` / `channelThreadMention`
   * MARKS on text nodes. The composer schema registers those names as NODES
   * (the @tiptap Mention extension), so loading a doc carrying the marks
   * directly would crash the editor (`There is no mark type userMention in
   * this schema`).
   *
   * When the matching node extension is registered (mentionSearch/context
   * provided), convert each mention-marked text run into a mention NODE so
   * the mention survives the edit as a chip and re-serializes to its facet on
   * save. When the extension is absent, drop the mark — the mention text
   * stays, only its special formatting is lost.
   */
  function normalizeMentionMarks(
    doc: ProseMirrorDoc,
    supported: { userMention: boolean; channelThreadMention: boolean },
  ): ProseMirrorDoc {
    const walk = (node: ProseMirrorDoc): void => {
      if (node.content) {
        const out: ProseMirrorNode[] = [];
        for (const child of node.content) {
          if (child.type === "text" && child.marks?.length) {
            const mentionMark = child.marks.find(
              (m): m is ProseMirrorMark & { type: "userMention" | "channelThreadMention" } =>
                m.type === "userMention" || m.type === "channelThreadMention",
            );
            if (mentionMark) {
              if (supported[mentionMark.type]) {
                // The marked text is the mention span (`@label` / `#label`);
                // rebuild the atomic mention node the composer would have
                // produced, keeping the facet's id and recovering the label
                // from the text.
                out.push({
                  type: mentionMark.type,
                  attrs: {
                    ...mentionMark.attrs,
                    label: (child.text ?? "").replace(/^[@#]/, ""),
                  },
                });
                continue;
              }
              child.marks = child.marks.filter((m) => m !== mentionMark);
            }
          }
          out.push(child);
        }
        node.content = out;
      }
      for (const child of node.content ?? []) walk(child);
    };
    walk(doc);
    return doc;
  }

  onMount(() => {
    const extensions = [
      // Headings enabled so markdown shortcuts (`# `, `## `, …) convert to
      // header blocks as the user types. Bullet/ordered list shortcuts
      // (`- `, `1. `) come from StarterKit's input rules by default.
      StarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5, 6] }, link: false }),
      Placeholder.configure({ placeholder }),
      RichTextLink.configure({
        openOnClick: false,
        autolink: true,
        defaultProtocol: "https",
      }),
      initKeyboardShortcutHandler({
        onEnter: wrappedOnEnter,
        sendOnEnter: () => resolveSendOnEnter(sendOnEnter, pointerCoarse.current),
      }),
      // `breaks: true` keeps single newlines (soft breaks) as hard breaks
      // instead of collapsing them to spaces — fixes newlines being stripped
      // when a message is re-parsed or edited.
      Markdown.configure({ breaks: true }),
    ];

    if (mentionSearch) {
      extensions.push(initUserMention({ search: mentionSearch }) as Extension);
    }
    if (context) {
      extensions.push(initSpaceContextMention({ context }) as Extension);
    }

    // When editing a rich-text message, initialize the editor from the
    // decoded blocks (as a ProseMirror doc) instead of the base64-encoded
    // wire `content` string. This surfaces the decoded message text to the
    // user and keeps the body rich-text on save. Sync the bindings so the
    // parent sees the initial markdown/blocks even before the user types.
    const initialDoc =
      initialBlocks && initialBlocks.length > 0
        ? normalizeMentionMarks(blocksToProseMirrorDoc(initialBlocks), {
            userMention: !!mentionSearch,
            channelThreadMention: !!context,
          })
        : null;

    tiptap = new Editor({
      element,
      extensions,
      content: initialDoc ?? content,
      editable: !disabled,
      editorProps: {
        attributes: {
          class: cn(
            // `roomy-prose` + `prose` opt the editable region into the shared
            // block typography (lib/message-typography.css) that the rendered
            // message uses — the composer is a WYSIWYG preview of the sent
            // message, not a separately-styled editor. `prose-invert` matches
            // MessageBubble so dark mode agrees too.
            "roomy-prose prose dark:prose-invert prose-a:text-accent-600 dark:prose-a:text-accent-400 prose-a:no-underline",
            // `text-sm font-normal` mirror MessageBubble's root, so inherited
            // metrics (notably line-height) are identical on both surfaces.
            // No explicit text colour: `.prose` supplies the body colour, the
            // same one the rendered message uses — hardcoding a base-* colour
            // here would diverge from the preview it is meant to be.
            "text-sm font-normal",
            "w-full max-w-full outline-none",
            "max-h-[30vh] overflow-y-auto",
          ),
        },
      },
      onUpdate: (ctx) => {
        content = ctx.editor.storage.markdown.getMarkdown();
        blocks = proseMirrorDocToBlocks(ctx.editor.getJSON());
        mentions = extractMentionDids(ctx.editor);
      },
    });
    if (initialDoc) {
      content = tiptap.storage.markdown.getMarkdown();
      blocks = proseMirrorDocToBlocks(tiptap.getJSON());
      mentions = extractMentionDids(tiptap);
    }
    // Only the composer registers as the module-level editor that
    // clearInput()/setInputFocus() target. Inline editors (edit-message)
    // must not overwrite it, or sending a message would clear the wrong
    // editor (or none) and the composer would stop clearing.
    if (composer) editor = tiptap;
    if (setFocus) {
      // focus at the end of the content
      tiptap?.commands.focus("end");
    }
  });

  $effect(() => {
    tiptap?.setEditable(!disabled);
    // Focus this editor (not the module-level composer editor) when the
    // `setFocus` prop is set — e.g. the edit-message editor must focus itself,
    // not the composer.
    if (setFocus && !disabled) tiptap?.commands.focus();
  });

  onDestroy(() => {
    tiptap?.destroy();
    // Reset the shared module-level binding so deferred setInputFocus/clearInput
    // calls (e.g. from messagingState.setReplyTo()/clear-context or a route's
    // setNormal) don't land on a destroyed editor whose commandManager is
    // null. Only the composer owns this binding, and only if it's still the
    // current editor.
    if (composer && editor === tiptap) editor = undefined;
  });

  const handlePaste = (event: ClipboardEvent) => {
    if (!processImageFile) return;

    const items = event.clipboardData?.items;
    if (!items) return;

    for (const item of Array.from(items)) {
      if (!item.type.startsWith("image/") && !item.type.startsWith("video/"))
        continue;
      const file = item.getAsFile();
      if (!file) continue;
      event.preventDefault();
      processImageFile(file);
    }
  };
</script>

<!-- Tiptap editor -->
<div
  id="chat-input"
  onpaste={handlePaste}
  bind:this={element}
  class="flex-1 min-w-0 w-full relative"
  role="region"
  aria-label="Chat editor"
></div>

<style>
  :global(.tiptap .is-empty::before) {
    color: var(--color-base-500);
    content: attr(data-placeholder);
    float: left;
    height: 0;
    pointer-events: none;
  }

  /*
    Block-node styling (headings, lists, quotes, code, spacing) is NOT defined
    here. It lives in `src/lib/message-typography.css`, imported globally by
    `app.css`, and is scoped to `.tiptap` for this editor and to `.roomy-prose`
    for rendered messages — one rule set, so the composer stays a WYSIWYG
    preview of the sent message. Only composer-specific chrome belongs below.
  */

  /* Mention chip rendered inline in the composer. Subtle accent rounded
     background + accent text; works in both themes because the bg is a
     translucent accent mix. Dark mode uses a lighter accent text color. */
  :global(.tiptap .mention) {
    background-color: color-mix(
      in oklab,
      var(--color-accent-500) 14%,
      transparent
    );
    color: var(--color-accent-700);
    border-radius: 0.375rem;
    padding: 0.05rem 0.3rem;
    font-weight: 500;
    text-decoration: none;
    cursor: default;
  }
  :global(.dark .tiptap .mention) {
    color: var(--color-accent-300);
  }
</style>
