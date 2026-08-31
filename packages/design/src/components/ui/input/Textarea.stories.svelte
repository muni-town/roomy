<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import Textarea from "./Textarea.svelte";

  const { Story } = defineMeta({
    title: "UI/Textarea",
    component: Textarea,
  });
</script>

{#snippet template(args)}
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
