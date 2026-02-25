<script lang="ts">
  import { Portal } from "bits-ui";
  import { ScrollArea } from "@foxui/core";
  import { cdnImageUrl } from "$lib/utils.svelte";

  let {
    uri,
    alt,
  }: {
    uri: string;
    alt?: string;
  } = $props();

  let imageZooming = $state(false);
  const encodedUri = encodeURIComponent(uri);
  const imageUrl = cdnImageUrl(uri);
</script>

<Portal>
  <!-- TODO: convert to native HTML dialog modal -->
  <div
    id={encodedUri}
    class="media-overlay"
    tabindex="0"
    aria-label="Dismiss image zoom"
    onclick={() => {
      imageZooming = false;
      window.location.href = "#";
    }}
    onkeydown={(e) => {
      if (e.key == " ") {
        imageZooming = !imageZooming;
      } else if (e.key == "Escape") {
        window.location.href = "#";
        imageZooming = false;
      }
    }}
  >
    <a
      class="flex justify-center items-center absolute top-8 right-8 font-bold size-12 py-3 rounded-full bg-black/50"
      href="#"
      onclick={() => {
        imageZooming = false;
      }}
    >
      X
    </a>
    <ScrollArea orientation="both" class="m-auto max-w-full max-h-full">
      <button
        aria-label="Toggle image zoom"
        onclick={(e) => {
          e.stopPropagation();
          imageZooming = !imageZooming;
        }}
      >
        <img
          src={imageUrl}
          {alt}
          class="transition-all duration-100 ease-linear"
          class:no-zoom={!imageZooming}
          onload={(e) => {
            const img = e.currentTarget as HTMLImageElement;
            img.setAttribute(
              "style",
              `max-width: ${img.naturalWidth}px; max-height: ${img.naturalHeight}px`,
            );
          }}
        />
      </button>
    </ScrollArea>
  </div>
</Portal>

<style>
  .media-overlay {
    display: flex;
    position: fixed;
    top: 0px;
    bottom: 0px;
    right: 0px;
    left: 0px;
    transition: all 0.5s;
    pointer-events: none;
    box-sizing: border-box;
    background-color: hsla(0, 0%, 0%, 0.86);
    opacity: 0;
    align-items: center;
    justify-content: center;
    overflow: auto;
  }
  .media-overlay:target {
    pointer-events: initial;
    opacity: 1;
  }
  .no-zoom {
    max-width: 90vw !important;
    max-height: 90vh !important;
  }
</style>
