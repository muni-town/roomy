<script lang="ts">
  import ImageUrlEmbed from "./ImageUrlEmbed.svelte";
  import VideoUrlEmbed from "./VideoUrlEmbed.svelte";

  let {
    media,
  }: {
    media: {
      uri: string;
      mimeType: string;
      alt?: string;
      width?: number;
      height?: number;
      blurhash?: string;
      size?: number;
    };
  } = $props();
</script>

{#if media.mimeType.startsWith("image/")}
  <ImageUrlEmbed image={media} />
{:else if media.mimeType.startsWith("video/")}
  <!-- TODO: Update VideoUrlEmbed to accept media object structure -->
  <VideoUrlEmbed video={media} />
{:else}
  <!-- Unsupported media type -->
  <div class="text-sm text-base-600 dark:text-base-400">
    Unsupported media type: {media.mimeType}
  </div>
{/if}
