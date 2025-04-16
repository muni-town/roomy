<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { Editor } from "@tiptap/core";
  import Placeholder from "@tiptap/extension-placeholder";
  import {
    type Item,
    initKeyboardShortcutHandler,
  } from "$lib/tiptap/editor";
  import { g } from "$lib/global.svelte";
  import { createCompleteExtensions } from "$lib/tiptap/editor";
  import { user } from "$lib/user.svelte";
  import { toast } from "svelte-french-toast";

  // Props (use Svelte's export let)
  export let content: Record<string, unknown> = { type: "doc", children: [] };
  export let users: Item[] = [];
  export let context: Item[] = [];
  export let onEnter: () => void;

  // Remove non-Svelte $state, $effect, and $bindable usage
  let tiptap: Editor | undefined;
  let element: HTMLDivElement | undefined;
  let fileInput: HTMLInputElement | null = null;
  let isInternalUpdate = false;

  // Extensions (replace createCompleteExtensions if needed)
  const extensions = [
    ...createCompleteExtensions({ users, context }),
    Placeholder.configure({ placeholder: "Write something ..." }),
    initKeyboardShortcutHandler({ onEnter })
  ];

  onMount(() => {
    tiptap = new Editor({
      element,
      extensions,
      content,
      editorProps: {
        attributes: {
          class: "w-full px-3 py-2 rounded bg-base-300 text-base-content outline-none",
        },
      },
      onUpdate({ editor }) {
        isInternalUpdate = true;
        content = editor.getJSON();
        isInternalUpdate = false;
      }
    });
  });

  // Keep editor content in sync with external content changes
  $: if (tiptap && !isInternalUpdate) {
    const currentContent = tiptap.getJSON();
    const newContent = content.type ? content : { type: "doc", children: [] };
    if (JSON.stringify(currentContent) !== JSON.stringify(newContent)) {
      try {
        tiptap.commands.setContent(newContent);
      } catch (error) {
        console.error('Error updating editor content:', error);
      }
    }
  }

  onDestroy(() => {
    tiptap?.destroy();
  });

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

  export function handlePaste(node: HTMLElement) {
    const pasteHandler = async (event: ClipboardEvent) => {
      // Get clipboard data
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

          // Show loading indicator
          const uploadButton = document.querySelector('[aria-label="Upload image"]');
          if (uploadButton) {
            uploadButton.setAttribute('disabled', 'true');
            uploadButton.setAttribute('title', 'Uploading...');
          }

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
            console.error("Error uploading pasted image:", error);
            toast.error("Failed to upload pasted image", { position: "bottom-right" });
          } finally {
            // Re-enable the upload button
            if (uploadButton) {
              uploadButton.removeAttribute('disabled');
              uploadButton.setAttribute('title', 'Upload image');
            }
          }

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

  async function handleFileProcess(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files?.length) return;

    const file = input.files[0];
    // Type guard to ensure file is defined
    if (!file || !file.type.startsWith("image/")) return;

    // Show loading indicator or disable the button while uploading
    const uploadButton = document.querySelector('[aria-label="Upload image"]');
    if (uploadButton) {
      uploadButton.setAttribute('disabled', 'true');
      uploadButton.setAttribute('title', 'Uploading...');
    }

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
      // Reset input so same file can be uploaded again if needed
      input.value = "";

      // Re-enable the upload button
      if (uploadButton) {
        uploadButton.removeAttribute('disabled');
        uploadButton.setAttribute('title', 'Upload image');
      }
    }
  }
</script>
{#if !g.isBanned}
  <div class="flex items-center gap-2">
    <!-- Plus icon button for image upload -->
    <button
      type="button"
      class="p-1 rounded hover:bg-base-200 disabled:opacity-50"
      aria-label="Upload image"
      use:handleClick
      tabindex="-1"
      disabled={tiptap == null}
      title={tiptap == null ? "Editor not ready" : "Upload image"}
    >
      <!-- Simple SVG plus icon -->
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
        <rect x="9" y="4" width="2" height="12" rx="1" fill="currentColor"/>
        <rect x="4" y="9" width="12" height="2" rx="1" fill="currentColor"/>
      </svg>
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
    <div bind:this={element} class="flex-1" use:handlePaste></div>
  </div>
{:else}
  <div
    class="w-full px-3 py-2 rounded bg-base-300 text-base-content outline-none cursor-not-allowed"
  >
    Your account has been banned in this space.
  </div>
{/if}
