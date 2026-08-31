<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import RichTextEditor from "./RichTextEditor.svelte";

  const { Story } = defineMeta({
    title: "RichText/RichTextEditor",
    component: RichTextEditor,
  });

  type Args = {
    content?: Record<string, unknown>;
    editable?: boolean;
    placeholder?: string;
  };
</script>

{#snippet template(args: Args)}
  <div class="p-4 w-full bg-base-50 dark:bg-base-950 min-h-[300px]">
    <RichTextEditor
      content={(args as any).content}
      editable={(args as any).editable}
      placeholder={(args as any).placeholder}
      onupdate={() => {}}
      ontransaction={() => {}}
      oncomment={() => {}}
    />
  </div>
{/snippet}

<Story
  name="Default"
  args={{ editable: false, placeholder: "Write or press / for commands" }}
  {template}
  parameters={{ layout: "fullscreen" }}
/>

<Story
  name="Editable"
  args={{ editable: true, placeholder: "Start typing…" }}
  {template}
  parameters={{ layout: "fullscreen" }}
/>

<Story
  name="WithContent"
  args={{
    editable: true,
    placeholder: "Write or press / for commands",
    content: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Hello from Storybook" }],
        },
      ],
    },
  }}
  {template}
  parameters={{ layout: "fullscreen" }}
/>
