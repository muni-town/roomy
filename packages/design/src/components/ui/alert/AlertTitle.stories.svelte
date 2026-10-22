<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import { type ComponentProps } from "svelte";
  import AlertTitle from "./AlertTitle.svelte";

  const { Story } = defineMeta({
    title: "UI/AlertTitle",
    component: AlertTitle,
    render: template,
  });
</script>

{#snippet template(args: ComponentProps<typeof AlertTitle>)}
  <div class="p-4">
    <AlertTitle level={args.level}>{#snippet children()}Attention!{/snippet}</AlertTitle>
  </div>
{/snippet}

<Story name="Default" args={{ level: 5 }} {template} />
<Story name="Level1" args={{ level: 1 }} {template} />
