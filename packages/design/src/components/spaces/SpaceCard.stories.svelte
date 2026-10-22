<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import SpaceCard from "./SpaceCard.svelte";

  const { Story } = defineMeta({
    title: "Spaces/SpaceCard",
    component: SpaceCard,
    render: template,
  });

  type Args = {
    name: string;
    description: string;
    href: string;
  };
</script>

{#snippet template(args: Args)}
  <div class="p-4">
    <SpaceCard
      name={args.name}
      description={args.description}
      href={args.href}
    >
      {#snippet avatar()}
        <div
          class="flex items-center justify-center rounded-2xl bg-accent-500/20 text-accent-600 dark:text-accent-400 font-bold"
          style="width: 56px; height: 56px;"
        >
          RG
        </div>
      {/snippet}
    </SpaceCard>
  </div>
{/snippet}

<Story
  name="Default"
  args={{
    name: "Roomy Garden",
    description: "A cozy corner of the network",
    href: "#/space",
  }}
  {template}
/>
