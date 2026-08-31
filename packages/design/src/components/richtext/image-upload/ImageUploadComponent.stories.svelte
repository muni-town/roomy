<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import ImageUploadComponent from "./ImageUploadComponent.svelte";
  import type { NodeViewProps } from "@tiptap/core";

  const { Story } = defineMeta({
    title: "RichText/ImageUploadComponent",
    component: ImageUploadComponent,
  });

  const nodeViewPropsMock = {
    node: {
      attrs: {
        src: "https://picsum.photos/seed/roomy/400/300",
        preview: "https://picsum.photos/seed/roomy/400/300",
      },
    },
    getPos: () => 0,
    deleteNode: () => {},
    insertContentAt: () => ({ run: () => {} }),
    selected: false,
    editor: {
      chain: () => ({
        focus: () => ({
          insertContentAt: () => ({ run: () => {} }),
        }),
      }),
    },
    extension: {
      options: {
        upload: async () => {
          console.log("upload");
          return "https://picsum.photos/seed/roomy/400/300";
        },
      },
    },
  } as unknown as NodeViewProps;
</script>

{#snippet template(_args)}
  <div class="p-4 w-full max-w-md">
    <ImageUploadComponent {...(nodeViewPropsMock as any)} />
  </div>
{/snippet}

<Story name="Default" {template} />
