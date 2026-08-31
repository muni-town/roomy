<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import AvatarGroup from "./AvatarGroup.svelte";

  const { Story } = defineMeta({
    title: "User/AvatarGroup",
    component: AvatarGroup,
  });

  type Args = {
    users: { src?: string; alt?: string; id?: string }[];
  };
</script>

{#snippet template(args: Args)}
  <div class="p-4">
    <AvatarGroup users={(args as any).users} />
  </div>
{/snippet}

<Story
  name="Default"
  args={{
    users: [
      { id: "ada" },
      { id: "grace", alt: "Grace" },
      { id: "alan" },
      { id: "katherine", alt: "Katherine" },
    ],
  }}
  {template}
/>
