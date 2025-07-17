<script lang="ts" module>
  export let fullscreenImage = $state({
    src: "https://placehold.co/1000x1000",
    show: true,
  });
</script>

{#if fullscreenImage.show}
  <button
    class="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center cursor-pointer"
    onclick={() => (fullscreenImage.show = false)}
  >
    <img
      src={fullscreenImage.src}
      alt=""
      class="w-full h-full object-contain"
    />
  </button>
{/if}
