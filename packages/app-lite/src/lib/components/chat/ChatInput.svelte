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
  import { initUserMention, initSpaceContextMention } from "$lib/tiptap/editor";
  import { extractMentionDids } from "$lib/tiptap/mentions";
  import { type Item, initKeyboardShortcutHandler } from "$lib/tiptap/editor";
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
     * When editing a rich-text message, the decoded blocks that seeded this
     * editor. When present, the editor initializes from
     * `blocksToProseMirrorDoc(initialBlocks)` instead of the markdown
     * `content` string, so structured messages open as their decoded text
     * (not the base64-encoded wire body) and stay rich-text on save.
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
    /** When false, bare Enter inserts a new block instead of sending. */
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
    sendOnEnter = true,
  }: Props = $props();

  let element: HTMLDivElement | undefined = $state();

  let tiptap: Editor | undefined = $state();

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
   * stays, only its special formatting is lost (the old behaviour).
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
      initKeyboardShortcutHandler({ onEnter: wrappedOnEnter, sendOnEnter }),
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
            // inputVariants({ variant: "primary" }),
            "w-full outline-none text-base-950 dark:text-base-50",
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
    // calls (e.g. from messagingState.setNormal() in a route $effect) don't
    // land on a destroyed editor whose commandManager is null. Only the
    // composer owns this binding, and only if it's still the current editor.
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
  class="flex-1 relative"
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
    WYSIWYG rendering for block nodes produced by markdown shortcuts
    (`- `, `1. `, `# `, `> `) and the slash menu. StarterKit converts these
    to bulletList/orderedList/heading/blockquote nodes, which render as plain
    `<ul>`/`<ol>`/`<h1>`-`<h6>`/`<blockquote>` elements. Without styling they
    look identical to plain text, so mirror the rendered-message styles
    (BlocksRenderer) here so the composer shows what will actually be sent.
  */
  :global(.tiptap ul) {
    list-style: disc;
    padding-left: 1.25rem;
    margin: 0.25rem 0;
  }
  :global(.tiptap ol) {
    list-style: decimal;
    padding-left: 1.25rem;
    margin: 0.25rem 0;
  }
  :global(.tiptap li) {
    margin: 0.125rem 0;
  }
  :global(.tiptap h1),
  :global(.tiptap h2),
  :global(.tiptap h3),
  :global(.tiptap h4),
  :global(.tiptap h5),
  :global(.tiptap h6) {
    font-weight: 600;
    margin: 0.25rem 0;
  }
  :global(.tiptap blockquote) {
    border-left: 2px solid var(--color-base-300);
    padding-left: 0.75rem;
    margin: 0.25rem 0;
  }
  :global(.dark .tiptap blockquote) {
    border-left-color: var(--color-base-600);
  }

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
