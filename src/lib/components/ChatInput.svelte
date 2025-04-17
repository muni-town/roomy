<script lang="ts">
  import { onMount, onDestroy, untrack } from "svelte";
  import { Editor } from "@tiptap/core";
  import StarterKit from "@tiptap/starter-kit";
  import Placeholder from "@tiptap/extension-placeholder";
  import {
    type Item,
    initKeyboardShortcutHandler,
    initUserMention,
    initSpaceContextMention,
  } from "$lib/tiptap/editor";
  import { g } from "$lib/global.svelte";

  type Props = {
    content: Record<any, any>;
    users: Item[];
    context: Item[];
    onEnter: () => void;
  };

  let { content = $bindable({}), users, context, onEnter }: Props = $props();
  let element: HTMLDivElement | undefined = $state();
  let extensions = $derived([
    StarterKit.configure({ heading: false }),
    Placeholder.configure({ placeholder: "Write something ..." }),
    initKeyboardShortcutHandler({ onEnter }),
    initUserMention({ users }),
    initSpaceContextMention({ context }),
  ]);

  let tiptap: Editor | undefined = $state();

  onMount(() => {
    tiptap = new Editor({
      element,
      extensions,
      content: content.type ? content : { type: "doc", children: [] },
      editorProps: {
        attributes: {
          class:
            "w-full px-3 py-2 rounded bg-base-300 text-base-content outline-none",
        },
      },
      onUpdate: (ctx) => {
        content = ctx.editor.getJSON();
      },
    });
  });

  $effect(() => {
    untrack(() => tiptap?.destroy());
    tiptap = new Editor({
      element,
      extensions,
      editorProps: {
        attributes: {
          class:
            "w-full px-3 py-2 rounded bg-base-300 text-base-content outline-none",
        },
      },
      onUpdate: (ctx) => {
        content = ctx.editor.getJSON();
      },
    });
  });

  onDestroy(() => {
    tiptap?.destroy();
  });
</script>

{#if !g.isBanned}
  <div bind:this={element}></div>
{:else}
  <div
    class="w-full px-3 py-2 rounded bg-base-300 text-base-content outline-none cursor-not-allowed"
  >
    Your account has been banned in this space.
  </div>
{/if}
