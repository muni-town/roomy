<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import RichTextEditorMenu from "./RichTextEditorMenu.svelte";
  import type { Editor } from "@tiptap/core";

  const { Story } = defineMeta({
    title: "RichText/RichTextEditorMenu",
    component: RichTextEditorMenu,
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

{#snippet template(args: { editable?: boolean })}
  <div class="p-4">
    <RichTextEditorMenu
      editor={editorMock}
      editable={(args as any).editable ?? false}
      isBold={false}
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
    />
  </div>
{/snippet}

<Story name="Default" args={{ editable: false }} {template} />

<Story name="Editable" args={{ editable: true }} {template} />
