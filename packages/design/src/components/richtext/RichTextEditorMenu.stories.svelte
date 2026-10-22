<script lang="ts" module>
  import { type ComponentProps } from "svelte";
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import RichTextEditorMenu from "./RichTextEditorMenu.svelte";
  import type { Editor } from "@tiptap/core";

  const { Story } = defineMeta({
    title: "RichText/RichTextEditorMenu",
    component: RichTextEditorMenu,
    render: template,
  });

  const editorMock = {
    isActive: () => false,
    chain: () => ({
      focus: () => ({
        toggleBold: () => ({ run: () => {} }),
        toggleItalic: () => ({ run: () => {} }),
        toggleUnderline: () => ({ run: () => {} }),
        toggleStrike: () => ({ run: () => {} }),
        run: () => {},
      }),
    }),
  } as unknown as Editor;
</script>

{#snippet template(args: ComponentProps<typeof RichTextEditorMenu>)}
  <div class="p-4">
    <RichTextEditorMenu
      editor={editorMock}
      editable={args.editable ?? false}
      isBold={false}
      isImage={false}
      isItalic={false}
      isUnderline={false}
      isStrikethrough={false}
      isLink={false}
      isComment={false}
      clickedLink={() => {}}
      clickedComment={() => {}}
      processImageFile={async () => {}}
      switchTo={() => {}}
      ref={null}
      selectedType="paragraph"
    />
  </div>
{/snippet}

<Story name="Default" args={{ editable: false }} {template} />

<Story name="Editable" args={{ editable: true }} {template} />
