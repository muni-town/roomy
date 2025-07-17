<script lang="ts">
  import { fullscreenImage } from "$lib/components/helper/FullscreenImage.svelte";
  import { ImageUrlEmbed } from "@roomy-chat/sdk";
  import { CoState } from "jazz-tools/svelte";

  let {
    embedId,
  }: {
    embedId: string;
  } = $props();

  let embed = $derived(new CoState(ImageUrlEmbed, embedId));
</script>

<button
  onclick={() => {
    if (!embed.current?.url) return;

    fullscreenImage.src = embed.current?.url;
    fullscreenImage.show = true;
  }}
  class="cursor-pointer"
>
  <img
    src={embed.current?.url}
    alt=""
    class="w-72 max-w-full h-auto max-h-64 object-contain"
  />
</button>
