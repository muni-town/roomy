<script lang="ts">
  let { onClick, onMobileClick, small = false }: { onClick: () => void, onMobileClick?: () => void, small: boolean } = $props();
</script>

<button
  onclick={(e) => {
    if (onMobileClick && window.innerWidth < 640) {
      onMobileClick();
    } else {
      onClick();
    }
  }}
  class="flex items-center rounded-lg px-2 py-1.5 group transition-all duration-300 ease-[cubic-bezier(0.33,1,0.68,1)] cursor-pointer"
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