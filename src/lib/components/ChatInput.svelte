<script lang="ts">
  import { Editor, editorViewOptionsCtx, rootCtx } from "@milkdown/kit/core";
  import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
  import { commonmark } from "@milkdown/kit/preset/commonmark";
  import { onMount } from "svelte";

  let { content = $bindable<string>("") } = $props();

  let editorDom: HTMLDivElement | undefined = $state();
  let milkdown = $state();

  onMount(async () => {
    if (editorDom) { 
      milkdown = await Editor.make()
        .config((ctx) => {
          ctx.update(editorViewOptionsCtx, (prev) => ({
            ...prev,
            attributes: {
              class: "w-full bg-violet-900 text-white px-3 py-2 rounded"
            }
          }));
          ctx.get(listenerCtx).updated((ctx, doc, prevDoc) => {
            content = doc.toJSON();
          });
          ctx.set(rootCtx, editorDom);
        })
        .use(commonmark)
        .use(listener)
        .create();
    }
  });
</script>

<div bind:this={editorDom}></div>
