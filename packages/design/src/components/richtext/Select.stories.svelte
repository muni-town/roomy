<script lang="ts" module>
  import { type ComponentProps } from "svelte";
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import Select from "./Select.svelte";

  const { Story } = defineMeta({
    title: "RichText/Select",
    component: Select,
    render: template,
  });

</script>

{#snippet template(args: ComponentProps<typeof Select>)}
  <div class="p-4 bg-base-50 dark:bg-base-950">
    <Select {...args} />
  </div>
{/snippet}

<Story
  name="Default"
  args={{
    type: "single",
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
