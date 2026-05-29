<script lang="ts" module>
  // DEPRECATED: This global state pattern is being phased out in favor of
  // FullscreenImageOverlay.svelte which uses hash-based routing and provides
  // better zoom controls. New code should use FullscreenImageOverlay instead.
  // See: /lib/components/content/thread/message/embeds/FullscreenImageOverlay.svelte
  export let fullscreenImage = $state({
    src: "https://placehold.co/1000x1000",
    show: false,
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
