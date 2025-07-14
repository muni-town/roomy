<script lang="ts">
  import { hls } from "$lib/actions/hls";
  import { VideoUrlEmbed } from "@roomy-chat/sdk";
  import { CoState } from "jazz-svelte";

  let {
    embedId,
  }: {
    embedId: string;
  } = $props();

  let embed = $derived(new CoState(VideoUrlEmbed, embedId));

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
</script>

<!-- hls should handle captions dynamically -->
<!-- svelte-ignore a11y_media_has_caption -->
<video
  class="w-72 max-w-full h-auto max-h-64 object-contain"
  controls
  use:hls={embed.current?.url?.endsWith(".m3u8")
    ? {
        playlist: embed.current.url,
        onError: handleError,
        onHasSubtitleTrack: handleHasSubtitleTrack,
        onLoading: handleLoading,
      }
    : undefined}
>
</video>
