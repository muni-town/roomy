<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import UserAvatar from "./UserAvatar.svelte";

  const { Story } = defineMeta({
    title: "User/UserAvatar",
    component: UserAvatar,
    render: template,
  });

  type Args = {
    name: string;
    size: number;
  };
</script>

{#snippet template(args: Args)}
  <div class="p-4">
    <UserAvatar name={args.name} size={args.size} />
  </div>
{/snippet}

<Story
  name="Default"
  args={{ name: "Ada Lovelace", size: 48 }}
  {template}
/>

<Story
  name="Large"
  args={{ name: "Ada Lovelace", size: 96 }}
  {template}
/>
