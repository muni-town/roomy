<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import SpaceAvatar from "./SpaceAvatar.svelte";

  const { Story } = defineMeta({
    title: "Spaces/SpaceAvatar",
    component: SpaceAvatar,
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
      name={(args as any).name}
      id={(args as any).id}
      size={(args as any).size}
      shape={(args as any).shape}
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
