<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import { type ComponentProps } from "svelte";
  import Textarea from "./Textarea.svelte";

  const { Story } = defineMeta({
    title: "UI/Textarea",
    component: Textarea,
    render: template,
  });
</script>

{#snippet template(args: ComponentProps<typeof Textarea>)}
  <div class="p-4">
    <Textarea placeholder={args.placeholder} value={args.value} />
  </div>
{/snippet}

<Story
  name="Default"
  args={{ placeholder: "Write a description…", value: "" }}
  {template}
/>
<Story
  name="WithValue"
  args={{
    placeholder: "Write a description…",
    value: "This room is for planning the next launch sprint.",
  }}
  {template}
/>
