<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import Input from "./Input.svelte";

  const { Story } = defineMeta({
    title: "UI/Input",
    component: Input,
  });
</script>

{#snippet template(args)}
  <div class="p-4">
    <Input
      placeholder={args.placeholder}
      type={args.type}
      variant={args.variant}
      disabled={args.disabled}
      value={args.value}
    />
  </div>
{/snippet}

<Story
  name="Default"
  args={{ placeholder: "Type something…", type: "text", value: "" }}
  {template}
/>
<Story
  name="Secondary"
  args={{ placeholder: "Type something…", type: "text", variant: "secondary", value: "" }}
  {template}
/>
<Story
  name="Disabled"
  args={{ placeholder: "Type something…", type: "text", value: "", disabled: true }}
  {template}
/>
