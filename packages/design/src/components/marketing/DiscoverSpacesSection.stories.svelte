<script lang="ts" module>
  import { type ComponentProps } from "svelte";
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import DiscoverSpacesSection from "./DiscoverSpacesSection.svelte";
  import DiscoverSpaceCard from "./DiscoverSpaceCard.svelte";
  import type { DiscoverableSpace } from "./types";

  const { Story } = defineMeta({
    title: "Marketing/DiscoverSpacesSection",
    component: DiscoverSpacesSection,
  });

  const ids = {
    garden: "did:plc:4moccs43r5v2xzkynae3xk2u",
    bookClub: "did:plc:gnwy2zbm3hu4gfdawzxmpb2s",
    pending: "did:plc:abcdefghijklmnopqrstuvwx",
    failed: "did:plc:fedcbazyxwvutsrqponmlkjih",
  };

  /**
   * The strip renders the caller's card body, so the story supplies what the
   * welcome page resolves: one entry per space id, in each of the three states
   * a lookup can be in.
   */
  const spaces: Record<string, DiscoverableSpace> = {
    [ids.garden]: {
      id: ids.garden,
      name: "Community Garden",
      description: "Plot swaps, seed libraries and the tomato report.",
    },
    [ids.bookClub]: { id: ids.bookClub, name: "Book Club" },
    [ids.pending]: { id: ids.pending, pending: true },
    [ids.failed]: { id: ids.failed, failed: true },
  };
</script>

{#snippet template(args: ComponentProps<typeof DiscoverSpacesSection>)}
  <div class="w-full">
    <DiscoverSpacesSection spaceIds={args.spaceIds} onDismiss={args.onDismiss}>
      {#snippet card(spaceId: string)}
        {@const space = spaces[spaceId] ?? { id: spaceId }}
        <DiscoverSpaceCard {space} />
      {/snippet}
    </DiscoverSpacesSection>
  </div>
{/snippet}

<Story
  name="Resolved"
  args={{
    spaceIds: [ids.garden, ids.bookClub, ids.pending],
    onDismiss: () => {},
  }}
  {template}
/>

<Story name="Failed" args={{ spaceIds: [ids.failed], onDismiss: () => {} }} {template} />

<Story name="Empty" args={{ spaceIds: [], onDismiss: () => {} }} {template} />
