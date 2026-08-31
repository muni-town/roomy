<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import InlineMono from "./InlineMono.svelte";

  const { Story } = defineMeta({
    title: "Helper/InlineMono",
    component: InlineMono,
  });
</script>

{#snippet template(args: { text: string })}
  <p class="p-4 text-sm">
    Run <InlineMono>{args.text}</InlineMono> to complete the setup.
  </p>
{/snippet}

<Story name="Default" args={{ text: "npm run dev" }} {template} />
