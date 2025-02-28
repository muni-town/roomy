<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { Editor } from "@tiptap/core";
  import { createTiptapInstance } from "$lib/tiptap/editor.svelte";

  let { content = $bindable({}) } = $props();
  let element: HTMLDivElement | undefined = $state();
  let tiptap: Editor | undefined = $state();

  // TODO: get users from context
  const users = [
    { value: "zeu.dev", label: "zeu.dev" },
    { value: "test.zeu.dev", label: "test.zeu.dev" }
  ];

  // TODO: get threads from context
  const threads = [
    { value: "id1", label: "bug fix" },
    { value: "id2", label: "feature idea" }
  ];

  // TODO: replace with automerge doc change submit function
  const onEnter= () => {
    console.log("ENTER", content);
  };


  $effect(() => {
    if (element) {
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