<script lang="ts">
  let fileInput: HTMLInputElement | undefined = $state();

  let {
    processImageFile,
    disabled,
  }: {
    processImageFile: (file: File) => void;
    disabled?: boolean;
  } = $props();

  function handleFileProcess(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files?.length) return;
    for (const file of input.files) {
      if (!file?.type.startsWith("image/")) continue;
      processImageFile(file);
    }
  }
</script>

<button
  class="p-1 rounded hover:bg-base-200 disabled:opacity-50"
  aria-label="Upload image"
  onclick={() => fileInput?.click()}
  tabindex="-1"
  {disabled}
  title={"Upload image"}
>
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
    <rect x="9" y="4" width="2" height="12" rx="1" fill="currentColor" />
    <rect x="4" y="9" width="12" height="2" rx="1" fill="currentColor" />
  </svg>
</button>

<input
  type="file"
  multiple
  accept="image/*"
  onchange={handleFileProcess}
  class="hidden"
  bind:this={fileInput}
/>
