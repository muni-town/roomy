<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import SpaceAvatar from "./SpaceAvatar.svelte";

  const { Story } = defineMeta({
    title: "Spaces/SpaceAvatar",
    component: SpaceAvatar,
    render: template,
  });

  type Args = {
    name: string;
    id: string;
    size: number;
    shape: "circle" | "squircle";
  };
</script>

{#snippet template(args: Args)}
  <div class="p-4">
    <SpaceAvatar
      name={args.name}
      id={args.id}
      size={args.size}
      shape={args.shape}
    />
  </div>
{/snippet}

<Story
  name="Circle"
  args={{ name: "Roomy Garden", id: "space-1", size: 64, shape: "circle" }}
  {template}
/>

<Story
  name="Squircle"
  args={{ name: "Roomy Garden", id: "space-1", size: 96, shape: "squircle" }}
  {template}
/>

<Story
  name="Small"
  args={{ name: "Roomy Garden", id: "space-1", size: 32, shape: "circle" }}
  {template}
/>
