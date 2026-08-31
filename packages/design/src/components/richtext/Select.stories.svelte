<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import Select from "./Select.svelte";

  const { Story } = defineMeta({
    title: "RichText/Select",
    component: Select,
  });

  type Args = {
    items: { value: string; label: string; disabled?: boolean }[];
    value?: string;
    placeholder?: string;
  };
</script>

{#snippet template(args: Args)}
  <div class="p-4 bg-base-50 dark:bg-base-950">
    <Select
      items={(args as any).items}
      value={(args as any).value}
      placeholder={(args as any).placeholder}
    />
  </div>
{/snippet}

<Story
  name="Default"
  args={{
    items: [
      { value: "p", label: "Paragraph" },
      { value: "h1", label: "Heading 1" },
      { value: "pre", label: "Code block" },
    ],
    value: "p",
    placeholder: "Choose",
  }}
  {template}
/>
