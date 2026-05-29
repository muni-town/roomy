<script lang="ts">
  type MediaItem = { url: string; type: string; alt?: string };

  type Props = {
    media: MediaItem[];
  };

  let { media }: Props = $props();
</script>

{#if media.length > 0}
  <div class="flex flex-col gap-2 mt-1">
    {#each media as item (item.url)}
      {#if item.type.startsWith("image/")}
        <img
          src={item.url}
          alt={item.alt ?? ""}
          class="max-w-sm max-h-80 rounded-lg object-contain"
          loading="lazy"
        />
      {:else if item.type.startsWith("video/")}
        <video
          controls
          preload="metadata"
          class="max-w-sm max-h-80 rounded-lg"
        >
          <source src={item.url} type={item.type} />
        </video>
      {:else}
        <a
          href={item.url}
          download
          class="text-xs text-primary underline break-all"
        >
          📎 {item.alt || "Download file"}
        </a>
      {/if}
    {/each}
  </div>
{/if}
