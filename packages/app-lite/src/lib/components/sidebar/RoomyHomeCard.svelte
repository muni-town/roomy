<script lang="ts">
  let { onClick, small = false }: { onClick: () => void, small: boolean } = $props();
</script>

<button
  onclick={onClick}
  class="flex items-center rounded-lg mx-2 mt-2 px-3 py-2 group transition-all duration-300 ease-[cubic-bezier(0.33,1,0.68,1)] text-left w-60 cursor-pointer"
  class:gap-1={small}
  class:gap-3={!small}
>
  <img
    src="/logo/roomy_blob_flat.png"
    alt="Roomy"
    class="shrink-0 transition-all duration-300 ease-[cubic-bezier(0.33,1,0.68,1)]"
    class:size-5={small}
    class:size-9={!small}
  />
  <span
    class="font-black text-base-700 tracking-[-0.015em] dark:text-base-300 truncate transition-all duration-300 ease-[cubic-bezier(0.33,1,0.68,1)]"
    class:text-lg={small}
    class:text-2xl={!small}
  >
    Roomy
  </span>
</button>