<script lang="ts">
  import { Portal } from "bits-ui";

  let isDragOver = $state(false);

  let {
    processImageFile,
  }: {
    processImageFile: (file: File) => void;
  } = $props();

  function handleDragOver(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();

    const dt = event.dataTransfer;
    if (!dt) return;

    // 1) If you only care about image files, look at dt.items (newer browsers)
    let imageCount = 0;
    if (dt.items) {
      // dt.items is a DataTransferItemList
      for (let i = 0; i < dt.items.length; i++) {
        const item = dt.items[i];
        // kind==='file' ensures it's a File, and type starts with "image/"
        if (item && item.kind === "file" && item.type.startsWith("image/")) {
          imageCount++;
        }
      }
    }
    // 2) Fallback: dt.files (FileList) – more widely supported
    else if (dt.files) {
      for (let i = 0; i < dt.files.length; i++) {
        const file = dt.files[i];
        if (file?.type.startsWith("image/")) {
          imageCount++;
        }
      }
    }

    isDragOver = imageCount > 0;
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
    for (const file of event.dataTransfer.files) {
      if (file?.type.startsWith("image/")) {
        processImageFile(file);
      }
    }
  }
</script>

<svelte:window
  ondragover={handleDragOver}
  ondragleave={handleDragLeave}
  ondrop={handleDrop}
/>

{#if isDragOver}
  <Portal>
    <div
      class="bg-base-100/80 dark:bg-base-900/80 backdrop-blur-md text-primary pointer-events-none absolute inset-0 flex items-center justify-center text-4xl font-bold z-[1000] dark:text-base-100"
    >
      Drop image to add it to your message
    </div>
  </Portal>
{/if}
