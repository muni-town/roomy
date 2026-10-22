<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import { type ComponentProps } from "svelte";
  import Badge from "./Badge.svelte";

  const { Story } = defineMeta({
    title: "UI/Badge",
    component: Badge,
    render: template,
  });
</script>

{#snippet template(args: ComponentProps<typeof Badge>)}
  <div class="p-4">
    <Badge variant={args.variant} size={args.size}>
      {#snippet children()}New{/snippet}
    </Badge>
  </div>
{/snippet}

<Story name="Primary" args={{ variant: "primary", size: "sm" }} {template} />
<Story name="Secondary" args={{ variant: "secondary" }} {template} />
<Story name="Red" args={{ variant: "red" }} {template} />
<Story name="Emerald" args={{ variant: "emerald" }} {template} />
<Story name="EmeraldMd" args={{ variant: "emerald", size: "md" }} {template} />
