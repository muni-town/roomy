<script lang="ts" module>
  import { type ComponentProps } from "svelte";
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import RichTextEditorLinkMenu from "./RichTextEditorLinkMenu.svelte";
  import type { Editor } from "@tiptap/core";

  const { Story } = defineMeta({
    title: "RichText/RichTextEditorLinkMenu",
    component: RichTextEditorLinkMenu,
    render: template,
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

{#snippet template(args: ComponentProps<typeof RichTextEditorLinkMenu>)}
  <div class="p-4">
    <RichTextEditorLinkMenu
      editor={editorMock}
      link={args.link ?? ""}
      editable={args.editable ?? false}
      ref={null}
      linkInput={null}
    />
  </div>
{/snippet}

<Story name="Default" args={{ link: "" }} {template} />

<Story name="Linked" args={{ link: "https://roomy.space" }} {template} />
