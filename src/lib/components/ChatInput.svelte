<script lang="ts">
  import { commandsCtx, Editor, editorViewOptionsCtx, rootCtx } from "@milkdown/kit/core";
  import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
  import { commonmark } from "@milkdown/kit/preset/commonmark";
  import { chainCommands, deleteSelection, selectAll } from "@milkdown/kit/prose/commands";
  import { $command as command, $useKeymap as useKeymap } from "@milkdown/kit/utils";
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
        .use(submitKeymap)
        .use(submitCommand)
        .create();
    }
  });

  const submitCommand = command("Submit", () => () => chainCommands(selectAll, deleteSelection));

  const submitKeymap = useKeymap("submitKeymap", {
    Submit: {
      shortcuts: "Enter",
      command: (ctx) => {
        const commands = ctx.get(commandsCtx);
        return () => commands.call(submitCommand.key, ctx);
      }
    }
  });
</script>

<div bind:this={editorDom}></div>