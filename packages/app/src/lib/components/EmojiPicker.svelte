<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import "emoji-picker-element";

  let {
    onEmojiPick,
  }: {
    onEmojiPick?: (emoji: string) => void;
  } = $props();

  let emojiPicker: (HTMLElement & any) | undefined = $state();

  function onEmojiPickHandler(event: Event & { detail: { unicode: string } }) {
    onEmojiPick?.(event.detail.unicode);
  }

  onMount(() => {
    emojiPicker?.addEventListener("emoji-click", onEmojiPickHandler);
  });

  onDestroy(() => {
    emojiPicker?.removeEventListener("emoji-click", onEmojiPickHandler);
  });
</script>

<emoji-picker bind:this={emojiPicker}></emoji-picker>
