<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import SpaceCards from "./SpaceCards.svelte";

  const { Story } = defineMeta({
    title: "Spaces/SpaceCards",
    component: SpaceCards,
  });

  const spaces = [
    { id: "did:plc:4moccs43r5v2xzkynae3xk2u", name: "Community Garden" },
    { id: "did:plc:gnwy2zbm3hu4gfdawzxmpb2s", name: "Book Club" },
    { id: "did:plc:abcdefghijklmnopqrstuvwx" },
  ];
</script>

<Story name="Default" args={{ spaces }} />

<Story name="Single" args={{ spaces: spaces.slice(0, 1) }} />
