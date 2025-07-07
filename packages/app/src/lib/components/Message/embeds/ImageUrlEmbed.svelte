<script lang="ts">
  import { ImageUrlEmbed } from "@roomy-chat/sdk";
  import { CoState } from "jazz-svelte";

  let {
    embedId,
  }: {
    embedId: string;
  } = $props();

  let embed = $derived(new CoState(ImageUrlEmbed, embedId));
</script>

<img
  src={embed.current?.url}
  alt=""
  class="w-72 max-w-full h-auto max-h-64 object-contain"
/>
