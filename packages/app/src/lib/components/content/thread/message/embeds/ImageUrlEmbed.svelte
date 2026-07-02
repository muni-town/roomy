<script lang="ts">
  import { decode } from "blurhash";
  import { cdnImageUrl } from "$lib/utils.svelte";
  import { IconImageOff } from "@roomy/design/icons";
  import FullscreenImageOverlay from "./FullscreenImageOverlay.svelte";

  let {
    image,
  }: {
    image: {
      uri: string;
      mimeType: string;
      alt?: string;
      width?: number;
      height?: number;
      blurhash?: string;
      size?: number;
    };
  } = $props();

  // Max display width for inline images. The virtualizer needs a stable
  // height to avoid recalculating row positions when images load.
  const MAX_DISPLAY_WIDTH = 240;

  // Compute aspect ratio from known dimensions. We always derive a
  // ratio so the container reserves vertical space before the image
  // loads, preventing layout shifts in the virtualizer.
  const hasDimensions = $derived(!!(image.width && image.height));
  const aspectRatio = $derived(
    hasDimensions ? image.width! / image.height! : 16 / 9,
  );

  // Reserved container size: cap width at MAX_DISPLAY_WIDTH and derive
  // height from the aspect ratio. This gives the virtualizer a stable
  // row height regardless of load state.
  const containerWidth = $derived(
    hasDimensions ? Math.min(image.width!, MAX_DISPLAY_WIDTH) : MAX_DISPLAY_WIDTH,
  );
  const containerHeight = $derived(Math.round(containerWidth / aspectRatio));

  const imageUrl = $derived(cdnImageUrl(image.uri));

  let hasError = $state(false);
  let isLoaded = $state(false);
  let blurhashDataUrl = $state<string | undefined>(undefined);

  // Generate blurhash preview if available
  $effect(() => {
    if (image.blurhash && image.width && image.height) {
      try {
        const pixels = decode(image.blurhash, 32, 32);
        const canvas = document.createElement("canvas");
        canvas.width = 32;
        canvas.height = 32;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          const imageData = ctx.createImageData(32, 32);
          imageData.data.set(pixels);
          ctx.putImageData(imageData, 0, 0);
          blurhashDataUrl = canvas.toDataURL();
        }
      } catch (e) {
        console.error("Failed to decode blurhash:", e);
      }
    }
  });

  function handleError() {
    hasError = true;
    isLoaded = true;
  }

  function handleLoad() {
    isLoaded = true;
  }
</script>

<!-- Container always reserves space (width × height) so the virtualizer
     measures a stable row height. The inner content (blurhash, image,
     or error state) fills this container. -->
<div
  class="relative rounded overflow-hidden shrink-0 max-w-full bg-base-200 dark:bg-base-800"
  style={`width: ${containerWidth}px; height: ${containerHeight}px`}
>
  {#if hasError}
    <!-- Broken image: show blurhash if available, else plain error state.
         Container keeps its reserved size so no layout shift. -->
    {#if blurhashDataUrl}
      <img
        src={blurhashDataUrl}
        alt={image.alt}
        class="absolute inset-0 w-full h-full object-cover blur-sm"
        aria-hidden="true"
      />
    {/if}
    <div class="absolute inset-0 flex items-center justify-center">
      <IconImageOff class="shrink-0 relative z-10" />
    </div>
  {:else}
    <!-- Blurhash placeholder fills the container until the real image loads -->
    {#if blurhashDataUrl && !isLoaded}
      <img
        src={blurhashDataUrl}
        alt={image.alt}
        class="absolute inset-0 w-full h-full object-cover blur-sm"
        aria-hidden="true"
      />
    {/if}

    <!-- Actual image -->
    <a
      href={`#${encodeURIComponent(image.uri)}`}
      aria-label="Open image fullscreen"
      class="absolute inset-0 block cursor-pointer"
    >
      <img
        src={imageUrl}
        alt={image.alt}
        class="w-full h-full object-cover relative z-10"
        class:opacity-0={!isLoaded}
        class:opacity-100={isLoaded}
        onerror={handleError}
        onload={handleLoad}
      />
    </a>

    <FullscreenImageOverlay uri={image.uri} alt={image.alt} />
  {/if}
</div>