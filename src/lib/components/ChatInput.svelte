<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { Editor } from "@tiptap/core";
  import StarterKit from "@tiptap/starter-kit";
  import Placeholder from "@tiptap/extension-placeholder";
  import Image from "@tiptap/extension-image";
  import { initUserMention, initSpaceContextMention } from "$lib/tiptap/editor";
  import {
    type Item,
    initKeyboardShortcutHandler,
  } from "$lib/tiptap/editor";
  import { g } from "$lib/global.svelte";
  import { createCompleteExtensions } from "$lib/tiptap/editor";
  import { user } from "$lib/user.svelte";
  import { toast } from "svelte-french-toast";
  import { untrack } from "svelte";
  import { isEqual } from "underscore";

  type Props = {
    content: Record<string, unknown>;
    users: Item[];
    context: Item[];
    onEnter: () => void;
    placeholder?: string;
  };

  let { content = $bindable({}), users, context, onEnter, placeholder = "Write something ..." }: Props = $props();
  let element: HTMLDivElement | undefined = $state();

  let tiptap: Editor | undefined = $state();
  let fileInput: HTMLInputElement | null = $state(null);

  // Flag to prevent circular updates between editor and content
  let isInternalUpdate = $state(false);

  // Track dependencies to avoid unnecessary editor recreation
  let lastDeps = $state({
    users: JSON.stringify(users),
    context: JSON.stringify(context),
    onEnter: onEnter.toString()
  });

  let extensions = $derived([
    StarterKit.configure({ heading: false }),
    Placeholder.configure({ placeholder }),
    initKeyboardShortcutHandler({ onEnter }),
    initUserMention({ users }),
    initSpaceContextMention({ context }),
  ]);

  let hasFocus = false;

  onMount(() => {
    tiptap = new Editor({
      element,
      extensions,
      content: content.type ? content : { type: "doc", content: [] },
      editorProps: {
        attributes: {
          class:
            "w-full px-3 py-2 rounded bg-base-300 text-base-content outline-none",
        },
      },
      onUpdate: (ctx) => {
        content = ctx.editor.getJSON();
      },
      onFocus: () => {
        hasFocus = true;
      },
      onBlur: () => {
        hasFocus = false;
      },
    });

  });

  // Flag to track whether an image is being uploaded
  let isUploading = $state(false);

  // Flag to track whether a file is being dragged over the drop area
  let isDragOver = $state(false);

  // Consolidated image file processing logic
  async function processImageFile(file: File, input?: HTMLInputElement) {
    // Show loading indicator or disable the button while uploading
    const uploadButton = document.querySelector('[aria-label="Upload image"]');
    if (uploadButton) {
      uploadButton.setAttribute('disabled', 'true');
      uploadButton.setAttribute('title', 'Uploading...');
    }
    isUploading = true;
    try {
      // Upload the image using the user.uploadBlob method
      const uploadResult = await user.uploadBlob(file);

      if (!tiptap) {
        console.warn("Tiptap editor not initialized");
        return;
      }

      // Get the raw image URL without any processing
      const imageUrl = uploadResult.url;

      // Insert image into editor with the raw URL
      tiptap.chain().focus().insertContent({
        type: "image",
        attrs: { src: imageUrl }
      }).run();
      
      // Update content state to ensure persistence
      content = tiptap.getJSON();
    } catch (error) {
      console.error("Error uploading image:", error);
      toast.error("Failed to upload image", { position: "bottom-right" });
    } finally {
      if (input) input.value = "";
      isUploading = false;
      // Re-enable the upload button
      if (uploadButton) {
        uploadButton.removeAttribute('disabled');
        uploadButton.setAttribute('title', 'Upload image');
      }
    }
  }

  // Action functions for event handling
  export function handleClick(node: HTMLElement) {
    const clickHandler = () => {
      fileInput?.click();
    };

    node.addEventListener('click', clickHandler);

    return {
      destroy() {
        node.removeEventListener('click', clickHandler);
      }
    };
  }

  // Updated handleFileProcess to use processImageFile
  async function handleFileProcess(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files?.length) return;
    const file = input.files[0];
    if (!file || !file.type.startsWith("image/")) return;
    await processImageFile(file, input);
  }

  export function handleChange(node: HTMLElement) {
    const changeHandler = (event: Event) => {
      handleFileProcess(event);
    };

    node.addEventListener('change', changeHandler);

    return {
      destroy() {
        node.removeEventListener('change', changeHandler);
      }
    };
  }

  // Updated handlePaste to use processImageFile
  export function handlePaste(node: HTMLElement) {
    const pasteHandler = async (event: ClipboardEvent) => {
      const items = event.clipboardData?.items;
      if (!items) return;
      // Check for image data in clipboard
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          // Get the image file from clipboard
          const file = item.getAsFile();
          if (!file) continue;
          // Prevent default paste behavior
          event.preventDefault();
          await processImageFile(file);
          // Only process the first image found
          return;
        }
      }
    };

    node.addEventListener('paste', pasteHandler);

    return {
      destroy() {
        node.removeEventListener('paste', pasteHandler);
      }
    };
  }

  // --- Drag-and-drop handlers for image upload ---
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
  async function handleDrop(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    isDragOver = false;
    if (!event.dataTransfer?.files?.length) return;
    const file = event.dataTransfer.files[0];
    if (file && file.type.startsWith("image/")) {
      await processImageFile(file);
    }
  }

  // Wrapped send handler for spinner
  function wrappedOnEnter() {
    Promise.resolve(onEnter());
  }

  // First effect: Create/recreate editor when dependencies change
  $effect(() => {
    if (!element) return;

    // Check if dependencies have actually changed
    const currentDeps = {
      users: JSON.stringify(users),
      context: JSON.stringify(context),
      onEnter: onEnter.toString()
    };

    const depsChanged =
      currentDeps.users !== lastDeps.users ||
      currentDeps.context !== lastDeps.context ||
      currentDeps.onEnter !== lastDeps.onEnter;

    // Only recreate editor if dependencies changed or editor doesn't exist
    if (!tiptap || depsChanged) {
      // Update tracked dependencies
      lastDeps = currentDeps;

      // Destroy previous editor if it exists
      tiptap?.destroy();

      // Create new extensions with current users/context/onEnter
      const extensions = [
        ...createCompleteExtensions({ users, context }),
        Placeholder.configure({ placeholder: "Write something ..." }),
        initKeyboardShortcutHandler({ onEnter })
      ];
      untrack(() => tiptap?.destroy());
      // Initialize the editor
      tiptap = new Editor({
        element,
        extensions,
        content: content.type ? content : { type: "doc", children: [] },
        editorProps: {
          attributes: {
            class: "w-full px-3 py-2 rounded bg-base-300 text-base-content outline-none",
          },
        },
        onUpdate: (ctx) => {
          const newContent = ctx.editor.getJSON();
          if (JSON.stringify(content) !== JSON.stringify(newContent)) {
            isInternalUpdate = true;
            content = newContent;
            // Reset the flag after the update is processed
            setTimeout(() => {
              isInternalUpdate = false;
            }, 0);
          }

        },
      });

      // Ensure fileInput is properly initialized
      if (!fileInput) {
        console.warn('File input not initialized properly');
      }
    }
  });

  // Second effect: Update editor content when content prop changes externally
  $effect(() => {
    if (!tiptap || isInternalUpdate) return;

    const currentContent = tiptap.getJSON();
    const newContent = content.type ? content : { type: "doc", children: [] };

    // Only update if content is actually different
    if (!isEqual(currentContent, newContent)) {
      isInternalUpdate = true;
      try {
        tiptap.commands.setContent(newContent);
      } finally {
        setTimeout(() => { isInternalUpdate = false; }, 0);
      }

      // (Optional) Restore focus/cursor logic here if needed
    }
  });

  onDestroy(() => {
    tiptap?.destroy();
  });
</script>
{#if !g.isBanned}
  <div class="flex items-center gap-2">
    <!-- Plus icon button for image upload -->
    <button
      type="button"
      class="p-1 rounded hover:bg-base-200 disabled:opacity-50 cursor-pointer"
      aria-label="Upload image"
      use:handleClick
      tabindex="-1"
      disabled={tiptap == null || isUploading}
      title={isUploading ? "Uploading..." : "Upload image"}
    >
      {#if isUploading}
        <!-- Loading spinner -->
        <div class="animate-spin h-5 w-5">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
        </div>
      {:else}
        <!-- Regular upload icon -->
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <rect x="9" y="4" width="2" height="12" rx="1" fill="currentColor"/>
          <rect x="4" y="9" width="12" height="2" rx="1" fill="currentColor"/>
        </svg>
      {/if}
    </button>
    <!-- Hidden file input for image upload -->
    <input
      type="file"
      accept="image/*"
      bind:this={fileInput}
      class="hidden"
      use:handleChange
      tabindex="-1"
    />
    <!-- Tiptap editor -->
    <div
      bind:this={element}
      class="flex-1 relative"
      use:handlePaste
      ondragover={handleDragOver}
      ondragleave={handleDragLeave}
      ondrop={handleDrop}
      role="region"
      aria-label="Chat editor and image drop area"
    >
      {#if isDragOver}
        <div class="absolute inset-0 z-10 bg-base-200/80 border-4 border-primary rounded flex justify-center items-center pointer-events-none select-none">
          <span class="text-lg font-semibold text-primary">Drop image to upload</span>
        </div>
      {/if}
    </div>
  </div>
  <div class="flex items-center gap-2 mt-2">
    <button
      class="btn btn-primary flex items-center"
      type="button"
      onclick={wrappedOnEnter}
      disabled={tiptap == null}
      aria-label="Send message"
    >
      Send
    </button>
  </div>
{:else}
  <div
    class="w-full px-3 py-2 rounded bg-base-300 text-base-content outline-none cursor-not-allowed"
  >
    Your account has been banned in this space.
  </div>
{/if}
