<script lang="ts">
  import { onDestroy } from "svelte";
  import { Editor } from "@tiptap/core";
  import { createTiptapInstance, type Item } from "$lib/tiptap/editor";

  type Props = {
    content: Record<any, any>;
    users: Item[];
    threads: Item[];
  };

  let { content = $bindable({}), users, threads }: Props = $props();
  let element: HTMLDivElement | undefined = $state();
  let tiptap: Editor | undefined = $state();

  // TODO: replace with automerge doc change submit function
  const onEnter= () => {
    console.log("ENTER", content);
  };

  $effect(() => {
    if (element && !tiptap) {
      tiptap = createTiptapInstance({
        element,
        content,
        onEnter,
        users,
        threads
      });
    }
  });

  onDestroy(() => { 
    tiptap?.destroy(); 
  });
</script>

<div bind:this={element}></div>