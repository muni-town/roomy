<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import Button from "./Button.svelte";

  const { Story } = defineMeta({
    title: "UI/Button",
    component: Button,
  });
</script>

{#snippet template(args)}
  <div class="p-4">
    <Button
      variant={args.variant}
      size={args.size}
      asyncState={args.asyncState}
      disabled={args.disabled}
    >
      {#snippet children()}{args.label}{/snippet}
    </Button>
  </div>
{/snippet}

<Story name="Primary" args={{ label: "Primary", variant: "primary" }} {template} />
<Story name="Cta" args={{ label: "Call to action", variant: "cta" }} {template} />
<Story name="Secondary" args={{ label: "Secondary", variant: "secondary" }} {template} />
<Story name="Toggle" args={{ label: "Toggle", variant: "toggle" }} {template} />
<Story name="Ghost" args={{ label: "Ghost", variant: "ghost" }} {template} />
<Story name="Link" args={{ label: "Link", variant: "link" }} {template} />
<Story name="Red" args={{ label: "Danger", variant: "red" }} {template} />
<Story name="Emerald" args={{ label: "Emerald", variant: "emerald" }} {template} />
<Story name="Loading" args={{ label: "Saving…", variant: "primary", asyncState: { status: "loading" } }} {template} />
