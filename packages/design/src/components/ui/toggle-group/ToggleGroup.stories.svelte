<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import ToggleGroup from "./ToggleGroup.svelte";

  const { Story } = defineMeta({
    title: "UI/ToggleGroup",
    component: ToggleGroup,
  });
</script>

{#snippet template(args)}
  <div class="p-4">
    <ToggleGroup
      name={args.name}
      options={args.options}
      value={args.value}
      onchange={noop}
    />
  </div>
{/snippet}

<script lang="ts">
  function noop() {}
</script>

<Story
  name="Default"
  args={{
    name: "access",
    options: [
      { label: "None", value: "none" },
      { label: "Read", value: "read" },
      { label: "Read + Write", value: "readwrite" },
    ],
    value: "read",
  }}
  {template}
/>
