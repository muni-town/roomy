<script lang="ts">
  import { hls } from "$lib/actions/hls";

  let {
    video,
  }: {
    video: {
      uri: string;
      mimeType: string;
      alt?: string;
      width?: number;
      height?: number;
      blurhash?: string;
      length?: number;
      size?: number;
    };
  } = $props();

  // optional handlers
  function handleError(e: Error | null) {
    if (e) console.error("Video error:", e);
  }

  function handleHasSubtitleTrack(v: boolean) {
    console.log("Subtitles available?", v);
  }

  function handleLoading(v: boolean) {
    console.log("HLS loading:", v);
  }

  const aspectRatio =
    video.width && video.height
      ? `aspect-ratio: ${(video.width || 1) / (video.height || 1)}`
      : "";
</script>

<!-- hls should handle captions dynamically -->
<!-- svelte-ignore a11y_media_has_caption -->
<video
  class="w-72 max-w-full h-auto max-h-64 object-contain"
  controls
  aria-label={video.alt}
  use:hls={video.uri?.endsWith(".m3u8")
    ? {
        playlist: video.uri,
        onError: handleError,
        onHasSubtitleTrack: handleHasSubtitleTrack,
        onLoading: handleLoading,
      }
    : undefined}
  style={aspectRatio}
>
</video>
