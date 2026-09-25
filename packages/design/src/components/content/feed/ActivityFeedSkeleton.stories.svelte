<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import ActivityFeedSkeleton from "./ActivityFeedSkeleton.svelte";

  const { Story } = defineMeta({
    title: "Content/Feed/ActivityFeedSkeleton",
    component: ActivityFeedSkeleton,
  });

  type Args = { count: number };
</script>

{#snippet template(args: Args)}
  <div class="w-full max-w-2xl p-4">
    <ActivityFeedSkeleton count={args.count} />
  </div>
{/snippet}

<Story name="Default" args={{ count: 5 }} {template} />

<Story name="Single" args={{ count: 1 }} {template} />
