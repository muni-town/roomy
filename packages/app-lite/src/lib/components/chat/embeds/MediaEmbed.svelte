<script lang="ts">
  import { resolveBlobUrl } from "$lib/utils";

  type MediaItem = { url: string; type: string; alt?: string };

  type Props = {
    media: MediaItem[];
  };

  let { media }: Props = $props();
</script>

{#if media.length > 0}
  <div class="flex flex-wrap gap-2 mt-1">
    {#each media as item (item.url)}
      {@const src = resolveBlobUrl(item.url) ?? item.url}
      {#if item.type.startsWith("image/")}
        <img
          src={src}
          alt={item.alt ?? ""}
          class="max-w-sm max-h-80 rounded-lg object-contain shrink-0"
          loading="lazy"
        />
      {:else if item.type.startsWith("video/")}
        <video
          controls
          preload="metadata"
          class="max-w-sm max-h-80 rounded-lg shrink-0"
        >
          <source src={src} type={item.type} />
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
