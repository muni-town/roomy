<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import RichTextEditorLinkMenu from "./RichTextEditorLinkMenu.svelte";
  import type { Editor } from "@tiptap/core";

  const { Story } = defineMeta({
    title: "RichText/RichTextEditorLinkMenu",
    component: RichTextEditorLinkMenu,
  });

  const editorMock = {
    isActive: () => false,
    chain: () => ({
      focus: () => ({
        extendMarkRange: () => ({ unsetLink: () => ({ run: () => {} }), setLink: () => ({ run: () => {} }) }),
        run: () => {},
      }),
    }),
  } as unknown as Editor;
</script>

{#snippet template(args: { link: string; editable?: boolean })}
  <div class="p-4">
    <RichTextEditorLinkMenu
      editor={editorMock}
      link={(args as any).link}
      editable={(args as any).editable ?? false}
    />
  </div>
{/snippet}

<Story name="Default" args={{ link: "" }} {template} />

<Story name="Linked" args={{ link: "https://roomy.space" }} {template} />
