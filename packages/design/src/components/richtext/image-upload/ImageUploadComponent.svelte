<script lang="ts">
  /***
   * From Fox UI by Flo-bit
   * https://github.com/flo-bit/ui-kit/tree/main/packages/text/src/lib/components/rich-text-editor
   */

  import type { NodeViewProps } from "@tiptap/core";
  import { onMount } from "svelte";
  import { NodeViewWrapper } from "svelte-tiptap";

  let props: NodeViewProps = $props();

  let progress = $state(0);

  const handleUpload = async (files?: File[]) => {
    console.log(props.node, props.node.attrs);

    const url = await props.extension.options.upload(files, (event: any) => {
      console.log("progress", event);
      progress = event.progress;
    });

    if (url) {
      const pos = props.getPos();
      const filename = files?.[0]?.name.replace(/\.[^/.]+$/, "") || "unknown";

      props.deleteNode();
      props.editor
        .chain()
        .focus()
        .insertContentAt(pos, [
          {
            type: "image",
            attrs: {
              src: props.node.attrs.preview,
              alt: filename,
              title: filename,
            },
          },
        ])
        .run();
    }
  };

  onMount(() => {
    console.log("node", props);
    handleUpload();
  });
</script>

<NodeViewWrapper class="relative">
  <img src={props.node.attrs.preview} alt="Upload preview" class="" />
  <div class="absolute left-0 right-0 bottom-0 h-1 bg-accent-500/30">
    <div
      class="h-full bg-accent-500 transition-all duration-300"
      style="width: {progress * 100}%"
    ></div>
  </div>
</NodeViewWrapper>
