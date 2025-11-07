<script lang="ts">
  import { decode } from "blurhash";
  import { cdnImageUrl } from "$lib/utils.svelte";
  import IconLucideImageOff from "~icons/lucide/image-off";
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

  const aspectRatio = (image.width || 1) / (image.height || 1);
  const imageUrl = cdnImageUrl(image.uri);

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

{#if hasError && !blurhashDataUrl}
  <!-- Error Loading (no blurhash available) -->
  <div
    class="w-40 h-28 flex items-center justify-center bg-base-200 dark:bg-base-800 rounded"
  >
    <IconLucideImageOff class="shrink-0" />
  </div>
{:else}
  <a
    href={hasError ? undefined : `#${encodeURIComponent(image.uri)}`}
    aria-label={hasError ? undefined : "Open image fullscreen"}
    class="relative block"
    class:cursor-pointer={!hasError}
    class:pointer-events-none={hasError}
  >
    <!-- Blurhash placeholder -->
    {#if blurhashDataUrl && !isLoaded}
      <img
        src={blurhashDataUrl}
        alt=""
        class="absolute inset-0 w-full h-full object-cover rounded blur-sm"
        aria-hidden="true"
      />
    {/if}

    <!-- Actual image or blurhash with error -->
    {#if hasError}
      <!-- Show blurhash with error icon overlay -->
      <div class="relative">
        <img
          src={blurhashDataUrl}
          alt=""
          class="rounded blur-sm"
          style={image.width && image.height
            ? `width: ${Math.min(image.width, 240)}px; aspect-ratio: ${aspectRatio}`
            : "width: 240px"}
          aria-hidden="true"
        />
        <div class="absolute inset-0 flex items-center justify-center">
          <IconLucideImageOff class="shrink-0 relative z-10" />
        </div>
      </div>
    {:else}
      <!-- Normal image loading -->
      <img
        src={imageUrl}
        alt={image.alt}
        class="max-w-[15em] rounded relative z-10"
        class:opacity-0={!isLoaded}
        class:opacity-100={isLoaded}
        style={image.width && image.height
          ? `aspect-ratio: ${aspectRatio}`
          : ""}
        onerror={handleError}
        onload={handleLoad}
      />
    {/if}
  </a>

  {#if !hasError}
    <FullscreenImageOverlay uri={image.uri} alt={image.alt} />
  {/if}
{/if}
