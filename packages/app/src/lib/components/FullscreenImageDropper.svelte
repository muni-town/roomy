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
    isDragOver = true;
    console.log("drag over");
  }
  function handleDragLeave(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    isDragOver = false;
    console.log("drag leave");
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
      class="bg-base-100/80 backdrop-blur-md text-primary pointer-events-none absolute inset-0 flex items-center justify-center text-4xl font-bold z-[1000]"
    >
      Drop image to add it to your message
    </div>
  </Portal>
{/if}
