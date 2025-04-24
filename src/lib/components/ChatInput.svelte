<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { Editor, Node, mergeAttributes } from "@tiptap/core";
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

  // Custom Image extension that adds a visual indicator for local images
  const CustomImage = Image.extend({
    renderHTML({ HTMLAttributes }) {
      const attrs = mergeAttributes(this.options.HTMLAttributes, HTMLAttributes);
      const isLocal = attrs['data-local'] === 'true';

      if (isLocal) {
        // For local images, wrap in a container with a label
        return [
          'div',
          { class: 'image-container' },
          ['img', { ...attrs, class: `${attrs.class || ''} local-image` }],
          ['span', { class: 'local-image-label' }, 'Local preview']
        ];
      }

      // For regular images, just return the img tag
      return ['img', attrs];
    }
  });

  type Props = {
    content: Record<string, unknown>;
    users: Item[];
    context: Item[];
    onEnter: () => void;
    placeholder?: string;
    editMode?: boolean; // Add this to indicate if the component is being used for editing
  };

  let { content = $bindable({}), users, context, onEnter, placeholder = "Write something ...", editMode = false }: Props = $props();
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
    CustomImage.configure({
      HTMLAttributes: {
        class: 'max-w-[300px] max-h-[300px] object-contain relative',
      },
    }),
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

  // Store local image files for later upload
  let localImages: Map<string, File> = $state(new Map());

  // Track which image URLs in the editor are local previews
  let localImageUrls: Set<string> = $state(new Set());

  // Process image file to create a local preview
  function processImageFile(file: File, input?: HTMLInputElement) {
    if (!tiptap) {
      console.warn("Tiptap editor not initialized");
      return;
    }

    try {
      // Create a local blob URL for the image
      const localUrl = URL.createObjectURL(file);

      // Store the file for later upload
      localImages.set(localUrl, file);
      localImageUrls.add(localUrl);

      // Insert image into editor with the local URL
      tiptap.chain().focus().insertContent({
        type: "image",
        attrs: {
          src: localUrl,
          'data-local': 'true' // Mark as local image
        }
      }).run();

      // Update content state to ensure persistence
      content = tiptap.getJSON();

      // Clear the file input if provided
      if (input) input.value = "";
    } catch (error) {
      console.error("Error creating image preview:", error);
      toast.error("Failed to create image preview", { position: "bottom-right" });
    }
  }

  // Upload all local images and replace their URLs in the editor content
  async function uploadLocalImages() {
    if (localImages.size === 0) return content;

    isUploading = true;
    const uploadButton = document.querySelector('[aria-label="Upload image"]');
    if (uploadButton) {
      uploadButton.setAttribute('disabled', 'true');
      uploadButton.setAttribute('title', 'Uploading...');
    }

    try {
      // Create a deep copy of the content to modify
      const contentCopy = JSON.parse(JSON.stringify(content));

      // Process all local images
      const uploadPromises: Promise<{localUrl: string, remoteUrl: string}>[] = [];

      // Start all uploads in parallel
      for (const [localUrl, file] of localImages.entries()) {
        uploadPromises.push(
          user.uploadBlob(file)
            .then(result => ({ localUrl, remoteUrl: result.url }))
            .catch(error => {
              console.error("Error uploading image:", error);
              toast.error("Failed to upload an image", { position: "bottom-right" });
              // Return the local URL as both to avoid breaking the content
              return { localUrl, remoteUrl: localUrl };
            })
        );
      }

      // Wait for all uploads to complete
      const results = await Promise.all(uploadPromises);

      // Replace local URLs with remote URLs in the content
      for (const { localUrl, remoteUrl } of results) {
        // Replace in the editor content
        replaceImageUrlInContent(contentCopy, localUrl, remoteUrl);

        // Clean up the local URL
        URL.revokeObjectURL(localUrl);
        localImages.delete(localUrl);
        localImageUrls.delete(localUrl);
      }

      return contentCopy;
    } catch (error) {
      console.error("Error uploading images:", error);
      toast.error("Failed to upload images", { position: "bottom-right" });
      return content;
    } finally {
      isUploading = false;
      if (uploadButton) {
        uploadButton.removeAttribute('disabled');
        uploadButton.setAttribute('title', 'Upload image');
      }
    }
  }

  // Helper function to replace image URLs in the content object
  function replaceImageUrlInContent(
    contentObj: Record<string, unknown> | Array<unknown> | null | undefined,
    oldUrl: string,
    newUrl: string
  ) {
    if (!contentObj) return;

    // If it's an array, process each item
    if (Array.isArray(contentObj)) {
      for (const item of contentObj) {
        if (item && typeof item === 'object') {
          replaceImageUrlInContent(item as Record<string, unknown>, oldUrl, newUrl);
        }
      }
      return;
    }

    // If it's an object, check if it's an image node
    if (typeof contentObj === 'object') {
      const obj = contentObj as Record<string, unknown>;

      if (obj.type === 'image' &&
          obj.attrs &&
          typeof obj.attrs === 'object') {

        const attrs = obj.attrs as Record<string, unknown>;

        if (attrs.src === oldUrl) {
          attrs.src = newUrl;
          // Remove the local data attribute
          if ('data-local' in attrs) {
            attrs['data-local'] = undefined;
          }
        }
      }

      // Process all properties recursively
      for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
          const value = obj[key];
          if (value && typeof value === 'object') {
            replaceImageUrlInContent(
              value as Record<string, unknown> | Array<unknown>,
              oldUrl,
              newUrl
            );
          }
        }
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
  function handleFileProcess(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files?.length) return;
    const file = input.files[0];
    if (!file || !file.type.startsWith("image/")) return;
    processImageFile(file, input);
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
    const pasteHandler = (event: ClipboardEvent) => {
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
          processImageFile(file);
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

  // Wrapped send handler for spinner
  async function wrappedOnEnter() {
    // If there are local images, upload them first
    if (localImages.size > 0) {
      // Show loading state
      isUploading = true;

      try {
        // Upload all local images and get updated content
        const updatedContent = await uploadLocalImages();

        // Update the content with the uploaded images
        content = updatedContent;

        // Now call the onEnter handler with the updated content
        await Promise.resolve(onEnter());
      } catch (error) {
        console.error("Error uploading images before sending:", error);
        toast.error("Failed to upload images", { position: "bottom-right" });
      } finally {
        isUploading = false;
      }
    } else {
      // No local images, just call onEnter
      await Promise.resolve(onEnter());
    }
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
        Placeholder.configure({ placeholder }),
        initKeyboardShortcutHandler({ onEnter }),
        // Explicitly add CustomImage extension to ensure it's available for editing messages with images
        CustomImage.configure({
          HTMLAttributes: {
            class: 'max-w-[300px] max-h-[300px] object-contain relative',
          },
        })
      ];
      untrack(() => tiptap?.destroy());
      // Initialize the editor
      try {
        // Convert content to a plain object if it's a Proxy
        let initialContent: Record<string, unknown>;
        try {
          initialContent = JSON.parse(JSON.stringify(content));
        } catch (e) {
          console.warn('Failed to convert initial content to plain object:', e);
          initialContent = content as Record<string, unknown>;
        }

        tiptap = new Editor({
          element,
          extensions,
          content: initialContent.type ? initialContent : { type: "doc", content: [] },
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
      } catch (error) {
        console.error('Error initializing editor:', error);
        toast.error("Failed to initialize editor", { position: "bottom-right" });
      }

      // Ensure fileInput is properly initialized
      if (!fileInput) {
        console.warn('File input not initialized properly');
      }
    }
  });

  // Second effect: Update editor content when content prop changes externally
  $effect(() => {
    if (!tiptap || isInternalUpdate) return;

    try {
      const currentContent = tiptap.getJSON();

      // Convert content to a plain object if it's a Proxy
      // This is crucial for handling images properly
      let plainContent: Record<string, unknown>;
      try {
        // Try to convert to plain object using JSON serialization
        plainContent = JSON.parse(JSON.stringify(content));
      } catch (e) {
        console.warn('Failed to convert content to plain object:', e);
        plainContent = content as Record<string, unknown>;
      }

      const newContent = plainContent.type ? plainContent : { type: "doc", content: [] };

      // Only update if content is actually different
      if (!isEqual(currentContent, newContent)) {
        isInternalUpdate = true;
        try {
          tiptap.commands.setContent(newContent);
        } finally {
          setTimeout(() => { isInternalUpdate = false; }, 0);
        }
      }
    } catch (error) {
      console.error('Error updating editor content:', error);
    }
  });

  onDestroy(() => {
    // Clean up any local blob URLs
    for (const localUrl of localImageUrls) {
      URL.revokeObjectURL(localUrl);
    }

    // Destroy the editor
    tiptap?.destroy();
  });
</script>
<style>
  /* Style for local image previews */
  :global(.local-image) {
    border: 2px dashed #3498db !important;
    border-radius: 4px !important;
    padding: 2px !important;
  }

  /* Container for local images to allow for the label */
  :global(.image-container) {
    position: relative;
    display: inline-block;
    margin: 2px;
  }

  /* Label for local images */
  :global(.local-image-label) {
    position: absolute;
    top: 0;
    left: 0;
    background-color: rgba(52, 152, 219, 0.7);
    color: white;
    font-size: 10px;
    padding: 2px 4px;
    border-bottom-right-radius: 4px;
    pointer-events: none;
    z-index: 1;
  }
</style>

{#if !g.isBanned}
  <div class="flex items-center gap-2">
    <!-- Plus icon button for image upload -->
    {#if !editMode}
      <button
        type="button"
        class="p-1 rounded hover:bg-base-200 disabled:opacity-50 cursor-pointer"
        aria-label="Upload image"
        use:handleClick
        tabindex="-1"
        disabled={tiptap == null || isUploading}
        title={isUploading ? "Uploading..." : localImages.size > 0 ? `${localImages.size} image${localImages.size > 1 ? 's' : ''} will be uploaded when you send` : "Upload image"}
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
    {/if}
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
  {#if !editMode}
    <div class="flex items-center gap-2 mt-2">
      <button
        class="btn btn-primary flex items-center gap-2"
        type="button"
        onclick={wrappedOnEnter}
        disabled={tiptap == null || isUploading}
        aria-label="Send message"
      >
        {#if isUploading}
          <div class="animate-spin h-4 w-4">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
          </div>
        {/if}
        Send
      </button>
    </div>
  {/if}
{:else}
  <div
    class="w-full px-3 py-2 rounded bg-base-300 text-base-content outline-none cursor-not-allowed"
  >
    Your account has been banned in this space.
  </div>
{/if}
