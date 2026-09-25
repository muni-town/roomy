<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import HandleDomainDialog from "./HandleDomainDialog.svelte";

  const { Story } = defineMeta({
    title: "Modals/HandleDomainDialog",
    component: HandleDomainDialog,
  });

  const did = "did:plc:drzgt2m6lmcel62gfbzjeap3";
</script>

{#snippet template(args: { open: boolean; did: string })}
  <HandleDomainDialog open={args.open} did={args.did} />
{/snippet}

<Story name="Open" args={{ open: true, did }} {template} />

<Story name="Closed" args={{ open: false, did }} {template} />
