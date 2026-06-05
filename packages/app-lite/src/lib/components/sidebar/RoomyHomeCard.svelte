<script lang="ts">
    let { onClick }: { onClick: () => void } = $props();
</script>

<button
  onclick={onClick}
  class="flex items-center gap-3 rounded-lg mx-2 mt-2 px-3 py-2 group transition-colors text-left w-60 cursor-pointer"
>
  <img
    src="/logo/roomy_blob_flat.png"
    alt="Roomy"
    class="size-9 shrink-0 rounded-full"
  />
  <span class="text-2xl font-black text-base-700 tracking-[-0.015em] group-hover:font-bold dark:text-base-300 truncate">
    Roomy
  </span>
</button>