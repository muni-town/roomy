<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import SuggestionSelect from "./SuggestionSelect.svelte";
  import type { Editor, Range } from "@tiptap/core";

  const { Story } = defineMeta({
    title: "RichText/SlashMenuSuggestionSelect",
    component: SuggestionSelect,
  });

  const editorMock = {
    isActive: () => false,
    chain: () => ({ focus: () => ({ run: () => {} }) }),
  } as unknown as Editor;

  const range: Range = { from: 1, to: 3 };

  const items = [
    {
      value: "paragraph",
      label: "Paragraph",
      command: () => {},
    },
    {
      value: "heading-1",
      label: "Heading 1",
      command: () => {},
    },
    {
      value: "bullet-list",
      label: "Bullet List",
      command: () => {},
    },
  ] as unknown as {
    value: string;
    label: string;
    command: ({ editor, range }: { editor: Editor; range: Range }) => void;
  }[];
</script>

{#snippet template(_args: { active?: number })}
  <div class="p-4 w-full max-w-xs">
    <SuggestionSelect {items} {range} editor={editorMock} active={0} />
  </div>
{/snippet}

<Story name="Default" {template} />
