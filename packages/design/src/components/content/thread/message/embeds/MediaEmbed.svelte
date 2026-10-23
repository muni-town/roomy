<script lang="ts">
  import { Portal } from "bits-ui";
  import { resolveBlobUrl, normalizeMimeType } from "../../../../../utils/index.js";

  type MediaItem = { url: string; type: string; alt?: string };

  type Props = {
    media: MediaItem[];
  };

  let { media }: Props = $props();

  let zoomedSrc = $state<string | null>(null);

  function openZoom(src: string) {
    zoomedSrc = src;
  }

  function closeZoom() {
    zoomedSrc = null;
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") closeZoom();
  }
</script>

{#if media.length > 0}
  <div class="flex flex-wrap gap-2 mt-1">
    {#each media as item (item.url)}
      {@const src = resolveBlobUrl(item.url, item.type) ?? item.url}
      {#if item.type.startsWith("image/")}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <img
          src={src}
          alt={item.alt ?? ""}
          class="max-w-full sm:max-w-sm max-h-80 rounded-lg object-contain shrink-0 cursor-zoom-in"
          loading="lazy"
          role="button"
          tabindex="0"
          onclick={() => openZoom(src)}
        />
      {:else if item.type.startsWith("video/")}
        <video
          controls
          preload="metadata"
          class="max-w-full sm:max-w-sm max-h-80 rounded-lg shrink-0"
        >
          <source src={src} type={normalizeMimeType(item.type)} />
        </video>
      {:else}
        <a
          href={src}
          download
          class="text-xs text-primary underline break-all"
        >
          📎 {item.alt || "Download file"}
        </a>
      {/if}
    {/each}
  </div>
{/if}

{#if zoomedSrc}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <Portal>
    <div
      role="dialog"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 cursor-zoom-out"
      onclick={closeZoom}
      onkeydown={onKeydown}
    >
      <img
        src={zoomedSrc}
        alt=""
        class="max-h-[90vh] max-w-[90vw] object-contain rounded-lg shadow-2xl cursor-zoom-out"
      />
    </div>
  </Portal>
{/if}

