<script lang="ts" module>
  let shouldRemoveComment = $state<CommentType[]>([]);

  export function markCommentForRemoval(comment: CommentType) {
    shouldRemoveComment = [...shouldRemoveComment, comment];
  }
</script>

<script lang="ts">
  /***
   * From Fox UI by Flo-bit
   * https://github.com/flo-bit/ui-kit/tree/main/packages/text/src/lib/components/rich-text-editor
   */

  import { onMount, onDestroy } from "svelte";
  import { Editor, Mark, mergeAttributes, type Content } from "@tiptap/core";
  import StarterKit from "@tiptap/starter-kit";
  import Placeholder from "@tiptap/extension-placeholder";
  import Image from "@tiptap/extension-image";
  // import { all, createLowlight } from "lowlight";
  // import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
  import BubbleMenu from "@tiptap/extension-bubble-menu";
  import Underline from "@tiptap/extension-underline";
  import RichTextEditorMenu from "./RichTextEditorMenu.svelte";
  import type { RichTextTypes } from ".";
  import RichTextEditorLinkMenu from "./RichTextEditorLinkMenu.svelte";
  import Slash, { suggestion } from "./slash-menu";
  import Typography from "@tiptap/extension-typography";
  import { RichTextLink } from "./RichTextLink";

  import "./code.css";
  import { cn } from "@fuxui/base";
  import { ImageUploadNode } from "./image-upload/ImageUploadNode";
  import { Transaction } from "@tiptap/pm/state";
  import type { Comment as CommentType } from "../content/thread/TimelineView.svelte";

  let {
    content = $bindable({}),
    editable = $bindable(false),
    placeholder = "Write or press / for commands",
    editor = $bindable(null),
    ref = $bindable(null),
    class: className,
    onupdate,
    ontransaction,
    oncomment,
  }: {
    content?: Content;
    editable?: boolean;
    placeholder?: string;
    editor?: Editor | null;
    ref?: HTMLDivElement | null;
    class?: string;
    onupdate?: (
      content: Content,
      context: { editor: Editor; transaction: Transaction },
    ) => void;
    ontransaction?: () => void;
    oncomment?: (selectedText: string, from: number, to: number) => void;
  } = $props();

  $effect(() => {
    console.log("editor is editable?", editable);
    if (editor?.isEditable !== editable) {
      editor?.setEditable(editable);
    }
  });

  $effect(() => {
    if (!editor) return;

    if (shouldRemoveComment.length) {
      for (const comment of shouldRemoveComment) {
        editor
          .chain()
          .focus()
          .setTextSelection({
            from: comment.from,
            to: comment.to,
          })
          .unsetMark("comment")
          .run();
      }
      shouldRemoveComment = [];
    }
  });

  let hasFocus = true;

  let menu: HTMLElement | null = $state(null);
  let menuLink: HTMLElement | null = $state(null);

  let selectedType: RichTextTypes = $state("paragraph");

  let isBold = $state(false);
  let isItalic = $state(false);
  let isUnderline = $state(false);
  let isStrikethrough = $state(false);
  let isLink = $state(false);
  let isImage = $state(false);
  let isComment = $state(false);

  const Comment = Mark.create({
    name: "comment",
    keepOnSplit: true,
    spanning: true,
    addOptions() {
      return {
        HTMLAttributes: {},
      };
    },
    parseHTML() {
      return [
        {
          tag: "span[data-comment]",
        },
      ];
    },
    renderHTML({ HTMLAttributes }) {
      return [
        "span",
        mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
          "data-comment": "true",
          class: "bg-accent-200/60",
        }),
        0,
      ];
    },
  });

  const CustomImage = Image.extend({
    // addAttributes(this) {
    // 	return {
    // 		inline: true,
    // 		allowBase64: true,
    // 		HTMLAttributes: {},
    // 		uploadImageHandler: { default: undefined }
    // 	};
    // },
    renderHTML({ HTMLAttributes }) {
      const attrs = mergeAttributes(
        this.options.HTMLAttributes,
        HTMLAttributes,
        {
          uploadImageHandler: undefined,
        },
      );
      // const isLocal = attrs["data-local"] === "true";

      // if (isLocal) {
      // 	// For local images, wrap in a container with a label
      // 	return [
      // 		'div',
      // 		{ class: 'image-container' },
      // 		['img', { ...attrs, class: `${attrs.class || ''} local-image` }],
      // 		['span', { class: 'local-image-label' }, 'Local preview']
      // 	];
      // }

      console.log("attrs", attrs);

      // For regular images, just return the img tag
      return ["img", attrs];
    },
  });

  onMount(() => {
    if (!ref) return;

    let extensions = [
      StarterKit.configure({
        dropcursor: {
          class: "text-accent-500/30 rounded-2xl",
          width: 2,
        },
        codeBlock: false,
        heading: {
          levels: [1, 2, 3],
        },
      }),
      Placeholder.configure({
        placeholder: ({ node }) => {
          // only show in paragraphs
          if (node.type.name === "paragraph" || node.type.name === "heading") {
            return placeholder;
          }
          return "";
        },
      }),
      Comment.configure(),
      CustomImage.configure({
        HTMLAttributes: {
          class: "max-w-full object-contain relative rounded-2xl",
        },
        allowBase64: true,
      }),
      // CodeBlockLowlight.configure({
      //   lowlight,
      //   defaultLanguage: "js",
      // }),
      BubbleMenu.configure({
        element: menu,
        shouldShow: ({ editor }) => {
          // dont show if image selected or no selection or is code block
          const shouldShow =
            !editor.isActive("image") &&
            !editor.view.state.selection.empty &&
            !editor.isActive("codeBlock") &&
            !editor.isActive("link") &&
            !editor.isActive("imageUpload");
          if (shouldShow) {
            console.log("should show?");
            menu?.classList.remove("hidden");
          }
          return shouldShow;
        },
        options: {},
        pluginKey: "bubble-menu-marks",
      }),
      BubbleMenu.configure({
        element: menuLink,
        shouldShow: ({ editor }) => {
          // only show if link is selected
          const shouldShow =
            editor.isEditable &&
            editor.isActive("link") &&
            !editor.view.state.selection.empty;
          if (shouldShow) {
            console.log("should show link menu?");
            menuLink?.classList.remove("hidden");
          }
          return shouldShow;
        },
        pluginKey: "bubble-menu-links",
      }),
      Underline.configure({}),
      RichTextLink.configure({
        openOnClick: false,
        autolink: true,
        defaultProtocol: "https",
      }),
      Slash.configure({
        suggestion: suggestion({
          char: "/",
          pluginKey: "slash",
          switchTo,
          processImageFile,
        }),
      }),
      Typography.configure(),
      ImageUploadNode.configure({
        upload: async (file, onProgress, _abortSignal) => {
          console.log("uploading image", file);
          // wait 2 seconds
          for (let i = 0; i < 10; i++) {
            await new Promise((resolve) => setTimeout(resolve, 200));
            onProgress?.({ progress: i / 10 });
          }

          return "https://picsum.photos/200/300";
        },
      }),
    ];

    editor = new Editor({
      editable,
      element: ref,
      extensions,
      editorProps: {
        attributes: {
          class: "outline-none",
        },
      },
      onUpdate: (ctx) => {
        content = ctx.editor.getJSON();
        onupdate?.(content, ctx);
      },
      onFocus: () => {
        hasFocus = true;
      },
      onBlur: () => {
        hasFocus = false;
      },
      onTransaction: (ctx) => {
        isBold = ctx.editor.isActive("bold");
        isItalic = ctx.editor.isActive("italic");
        isUnderline = ctx.editor.isActive("underline");
        isStrikethrough = ctx.editor.isActive("strike");
        isLink = ctx.editor.isActive("link");
        isImage = ctx.editor.isActive("image");
        isComment = ctx.editor.isActive("comment");

        if (ctx.editor.isActive("heading", { level: 1 })) {
          selectedType = "heading-1";
        } else if (ctx.editor.isActive("heading", { level: 2 })) {
          selectedType = "heading-2";
        } else if (ctx.editor.isActive("heading", { level: 3 })) {
          selectedType = "heading-3";
        } else if (ctx.editor.isActive("blockquote")) {
          selectedType = "blockquote";
        } else if (ctx.editor.isActive("code")) {
          selectedType = "code";
        } else if (ctx.editor.isActive("bulletList")) {
          selectedType = "bullet-list";
        } else if (ctx.editor.isActive("orderedList")) {
          selectedType = "ordered-list";
        } else {
          selectedType = "paragraph";
        }
        ontransaction?.();
      },
      content,
    });
  });

  // Flag to track whether a file is being dragged over the drop area
  let isDragOver = $state(false);

  // Store local image files for later upload
  let localImages: Map<string, File> = $state(new Map());

  // Track which image URLs in the editor are local previews
  let localImageUrls: Set<string> = $state(new Set());

  // Process image file to create a local preview
  async function processImageFile(file: File) {
    if (!editor) {
      console.warn("Tiptap editor not initialized");
      return;
    }

    try {
      const localUrl = URL.createObjectURL(file);

      localImages.set(localUrl, file);
      localImageUrls.add(localUrl);

      //editor.commands.setImageUploadNode();
      editor
        .chain()
        .focus()
        .setImageUploadNode({
          preview: localUrl,
        })
        .run();

      // wait 2 seconds
      // await new Promise((resolve) => setTimeout(resolve, 500));

      // content = editor.getJSON();

      // console.log('replacing image url in content');
      // replaceImageUrlInContent(content, localUrl, 'https://picsum.photos/200/300');
      // editor.commands.setContent(content);
    } catch (error) {
      console.error("Error creating image preview:", error);
    }
  }

  const handlePaste = (event: ClipboardEvent) => {
    const items = event.clipboardData?.items;
    if (!items) return;
    // Check for image data in clipboard
    for (const item of Array.from(items)) {
      if (!item.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (!file) continue;
      event.preventDefault();
      processImageFile(file);
      return;
    }
  };

  function handleDragOver(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    isDragOver = true;
  }
  function handleDragLeave(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    isDragOver = false;
  }
  function handleDrop(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    isDragOver = false;
    if (!event.dataTransfer?.files?.length) return;
    const file = event.dataTransfer.files[0];
    if (file?.type.startsWith("image/")) {
      processImageFile(file);
    }
  }

  onDestroy(() => {
    for (const localUrl of localImageUrls) {
      URL.revokeObjectURL(localUrl);
    }

    editor?.destroy();
  });

  let link = $state("");

  let linkInput: HTMLInputElement | null = $state(null);

  function clickedLink() {
    if (isLink) {
      //tiptap?.chain().focus().unsetLink().run();
      // get current link
      link = editor?.getAttributes("link").href;

      setTimeout(() => {
        linkInput?.focus();
      }, 100);
    } else {
      link = "";
      // set link
      editor?.chain().focus().setLink({ href: link }).run();

      setTimeout(() => {
        linkInput?.focus();
      }, 100);
    }
  }

  function clickedComment() {
    if (isComment) {
      // remove comment mark
      editor
        ?.chain()
        .focus()
        .extendMarkRange("comment")
        .unsetMark("comment")
        .run();
      if (!oncomment) throw new Error("oncomment is not defined");
      oncomment("", 0, 0);
      return;
    } else {
      if (!editor) throw new Error("Editor is not defined");
      if (!oncomment) throw new Error("oncomment is not defined");

      editor.chain().focus().setMark("comment").run();

      const { from, to } = editor.state.selection;
      const selectedText = editor.state.doc.textBetween(from, to, " "); // plain text
      oncomment(selectedText, from, to);
    }
  }

  function switchTo(value: RichTextTypes) {
    editor?.chain().focus().setParagraph().run();

    if (value === "heading-1") {
      editor?.chain().focus().setNode("heading", { level: 1 }).run();
    } else if (value === "heading-2") {
      editor?.chain().focus().setNode("heading", { level: 2 }).run();
    } else if (value === "heading-3") {
      editor?.chain().focus().setNode("heading", { level: 3 }).run();
    } else if (value === "blockquote") {
      editor?.chain().focus().setBlockquote().run();
    } else if (value === "code") {
      editor?.chain().focus().setCodeBlock().run();
    } else if (value === "bullet-list") {
      editor?.chain().focus().toggleBulletList().run();
    } else if (value === "ordered-list") {
      editor?.chain().focus().toggleOrderedList().run();
    }
  }
</script>

<div
  bind:this={ref}
  class={cn("relative flex-1", className)}
  onpaste={handlePaste}
  ondragover={handleDragOver}
  ondragleave={handleDragLeave}
  ondrop={handleDrop}
  role="region"
></div>

<RichTextEditorMenu
  bind:ref={menu}
  bind:editable
  {editor}
  {isBold}
  {isItalic}
  {isUnderline}
  {isStrikethrough}
  {isLink}
  {isImage}
  {isComment}
  {clickedLink}
  {clickedComment}
  {processImageFile}
  {switchTo}
  bind:selectedType
/>

<RichTextEditorLinkMenu
  bind:ref={menuLink}
  bind:editable
  {editor}
  bind:link
  bind:linkInput
/>

<style>
  :global(.tiptap) {
    :first-child {
      margin-top: 0;
    }

    :global(img) {
      display: block;
      height: auto;
      margin: 1.5rem 0;
      max-width: 100%;

      &.ProseMirror-selectednode {
        outline: 3px solid var(--color-accent-500);
      }
    }

    :global(div[data-type="image-upload"]) {
      &.ProseMirror-selectednode {
        outline: 3px solid var(--color-accent-500);
      }
    }

    :global(blockquote p:first-of-type::before) {
      content: none;
    }

    :global(blockquote p:last-of-type::after) {
      content: none;
    }

    :global(blockquote p) {
      font-style: normal;
    }
  }

  :global(.tiptap .is-empty::before) {
    color: var(--color-base-500);
    content: attr(data-placeholder);
    float: left;
    height: 0;
    pointer-events: none;
  }
</style>
