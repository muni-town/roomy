<script lang="ts">
  /***
   * RichTextEditorMenu From Fox UI by Flo-bit
   * https://github.com/flo-bit/ui-kit/tree/main/packages/text/src/lib/components/rich-text-editor
   */

  import { Toggle } from "@foxui/core";
  import type { Editor } from "@tiptap/core";
  import Select from "./Select.svelte";
  import type { RichTextTypes } from ".";
  import { IconChatBubbleText } from "@roomy/design/icons";

  let {
    editor,
    editable = $bindable(false),
    isBold,
    // isImage,
    isItalic,
    isUnderline,
    isStrikethrough,
    isLink,
    isComment,
    clickedLink,
    clickedComment,
    selectedType = $bindable("paragraph"),
    ref = $bindable(null),
    processImageFile,
    switchTo,
  }: {
    editor: Editor | null;
    editable: boolean;
    isBold: boolean;
    isImage: boolean;
    isItalic: boolean;
    isUnderline: boolean;
    isStrikethrough: boolean;
    isLink: boolean;
    isComment: boolean;
    clickedLink: () => void;
    clickedComment: () => void;
    selectedType: RichTextTypes;
    ref: HTMLElement | null;
    processImageFile: (file: File, input: HTMLInputElement) => void;
    switchTo: (value: RichTextTypes) => void;
  } = $props();

  $inspect(isBold);

  function handleFileProcess(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files?.length) return;
    const file = input.files[0];
    if (!file || !file.type.startsWith("image/")) return;
    processImageFile(file, input);
  }

  $effect(() => {
    editable;
  });

  let _fileInput = $state<HTMLInputElement | null>(null);
</script>

<div
  bind:this={ref}
  class="bg-base-50 dark:bg-base-900 border-base-500/20 dark:border-base-700/20 relative hidden w-fit rounded-2xl border px-1 py-1 shadow-lg backdrop-blur-sm"
>
  {#if editable}
    <Select
      onValueChange={(value) => {
        switchTo(value as RichTextTypes);
      }}
      type="single"
      items={[
        { value: "paragraph", label: "Text" },
        { value: "heading-1", label: "Heading 1" },
        { value: "heading-2", label: "Heading 2" },
        { value: "heading-3", label: "Heading 3" },
        { value: "blockquote", label: "Blockquote" },
        { value: "code", label: "Code Block" },
        { value: "bullet-list", label: "Bullet List" },
        { value: "ordered-list", label: "Ordered List" },
      ]}
      bind:value={selectedType}
    />
    <!-- <Tooltip withContext text="Bold" delayDuration={0}>
		{#snippet child({ props })} -->

    <Toggle
      size="sm"
      onclick={() => editor?.chain().focus().toggleBold().run()}
      bind:pressed={() => isBold, (_bold) => {}}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="currentColor"
        class="size-6"
      >
        <path
          fill-rule="evenodd"
          d="M5.246 3.744a.75.75 0 0 1 .75-.75h7.125a4.875 4.875 0 0 1 3.346 8.422 5.25 5.25 0 0 1-2.97 9.58h-7.5a.75.75 0 0 1-.75-.75V3.744Zm7.125 6.75a2.625 2.625 0 0 0 0-5.25H8.246v5.25h4.125Zm-4.125 2.251v6h4.5a3 3 0 0 0 0-6h-4.5Z"
          clip-rule="evenodd"
        />
      </svg>

      <span class="sr-only">Bold</span>
    </Toggle>
    <!-- {/snippet}
	</Tooltip> -->
    <Toggle
      size="sm"
      onclick={() => editor?.chain().focus().toggleItalic().run()}
      bind:pressed={() => isItalic, (_italic) => {}}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="currentColor"
        class="size-6"
      >
        <path
          fill-rule="evenodd"
          d="M10.497 3.744a.75.75 0 0 1 .75-.75h7.5a.75.75 0 0 1 0 1.5h-3.275l-5.357 15.002h2.632a.75.75 0 1 1 0 1.5h-7.5a.75.75 0 1 1 0-1.5h3.275l5.357-15.002h-2.632a.75.75 0 0 1-.75-.75Z"
          clip-rule="evenodd"
        />
      </svg>

      <span class="sr-only">Italic</span>
    </Toggle>

    <Toggle
      size="sm"
      onclick={() => editor?.chain().focus().toggleUnderline().run()}
      bind:pressed={() => isUnderline, (_underline) => {}}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="currentColor"
        class="size-6"
      >
        <path
          fill-rule="evenodd"
          d="M5.995 2.994a.75.75 0 0 1 .75.75v7.5a5.25 5.25 0 1 0 10.5 0v-7.5a.75.75 0 0 1 1.5 0v7.5a6.75 6.75 0 1 1-13.5 0v-7.5a.75.75 0 0 1 .75-.75Zm-3 17.252a.75.75 0 0 1 .75-.75h16.5a.75.75 0 0 1 0 1.5h-16.5a.75.75 0 0 1-.75-.75Z"
          clip-rule="evenodd"
        />
      </svg>

      <span class="sr-only">Underline</span>
    </Toggle>

    <Toggle
      size="sm"
      onclick={() => editor?.chain().focus().toggleStrike().run()}
      bind:pressed={() => isStrikethrough, (_strikethrough) => {}}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="currentColor"
        class="size-6"
      >
        <path
          fill-rule="evenodd"
          d="M9.657 4.728c-1.086.385-1.766 1.057-1.979 1.85-.214.8.046 1.733.81 2.616.746.862 1.93 1.612 3.388 2.003.07.019.14.037.21.053h8.163a.75.75 0 0 1 0 1.5h-8.24a.66.66 0 0 1-.02 0H3.75a.75.75 0 0 1 0-1.5h4.78a7.108 7.108 0 0 1-1.175-1.074C6.372 9.042 5.849 7.61 6.229 6.19c.377-1.408 1.528-2.38 2.927-2.876 1.402-.497 3.127-.55 4.855-.086A8.937 8.937 0 0 1 16.94 4.6a.75.75 0 0 1-.881 1.215 7.437 7.437 0 0 0-2.436-1.14c-1.473-.394-2.885-.331-3.966.052Zm6.533 9.632a.75.75 0 0 1 1.03.25c.592.974.846 2.094.55 3.2-.378 1.408-1.529 2.38-2.927 2.876-1.402.497-3.127.55-4.855.087-1.712-.46-3.168-1.354-4.134-2.47a.75.75 0 0 1 1.134-.982c.746.862 1.93 1.612 3.388 2.003 1.473.394 2.884.331 3.966-.052 1.085-.384 1.766-1.056 1.978-1.85.169-.628.046-1.33-.381-2.032a.75.75 0 0 1 .25-1.03Z"
          clip-rule="evenodd"
        />
      </svg>

      <span class="sr-only">Strikethrough</span>
    </Toggle>

    <Toggle
      size="sm"
      onclick={() => {
        clickedLink();
      }}
      bind:pressed={() => isLink, (_link) => {}}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="currentColor"
        class="size-6"
      >
        <path
          fill-rule="evenodd"
          d="M19.902 4.098a3.75 3.75 0 0 0-5.304 0l-4.5 4.5a3.75 3.75 0 0 0 1.035 6.037.75.75 0 0 1-.646 1.353 5.25 5.25 0 0 1-1.449-8.45l4.5-4.5a5.25 5.25 0 1 1 7.424 7.424l-1.757 1.757a.75.75 0 1 1-1.06-1.06l1.757-1.757a3.75 3.75 0 0 0 0-5.304Zm-7.389 4.267a.75.75 0 0 1 1-.353 5.25 5.25 0 0 1 1.449 8.45l-4.5 4.5a5.25 5.25 0 1 1-7.424-7.424l1.757-1.757a.75.75 0 1 1 1.06 1.06l-1.757 1.757a3.75 3.75 0 1 0 5.304 5.304l4.5-4.5a3.75 3.75 0 0 0-1.035-6.037.75.75 0 0 1-.354-1Z"
          clip-rule="evenodd"
        />
      </svg>

      <span class="sr-only">Link</span>
    </Toggle>
  {/if}

  <Toggle
    size="sm"
    onclick={() => {
      clickedComment();
    }}
    bind:pressed={() => isComment, (_comment) => {}}
  >
    <IconChatBubbleText class="size-6" />
    <span class="sr-only">Comment</span>
  </Toggle>

  <!-- <Toggle
		size="sm"
		onclick={() => {
			fileInput?.click();
		}}
		bind:pressed={() => isImage, (image) => {}}
	>
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			><rect width="18" height="18" x="3" y="3" rx="2" ry="2" /><circle cx="9" cy="9" r="2" /><path
				d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"
			/></svg
		>
	</Toggle> -->

  <input
    type="file"
    accept="image/*"
    class="hidden"
    onchange={handleFileProcess}
    tabindex="-1"
    bind:this={_fileInput}
  />
</div>
