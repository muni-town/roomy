<script lang="ts">
  import { page } from "$app/state";
  import Badge from "@roomy/design/components/ui/badge/Badge.svelte";
  import { createSpaceMetadataQuery } from "$lib/queries/space-metadata";
  import { createFeatureFlagsQuery } from "$lib/queries/feature-flags";
  import { FREE_BRIDGE_MEMBER_LIMIT } from "$lib/config";
  import IntegrationSection from "$lib/components/integrations/IntegrationSection.svelte";
  import BlueskySection from "$lib/components/integrations/BlueskySection.svelte";
  import DiscordBridgeSection from "$lib/components/integrations/DiscordBridgeSection.svelte";
  import MatrixSection from "$lib/components/integrations/MatrixSection.svelte";

  const spaceId = $derived(page.params.space!);

  const metaQuery = createSpaceMetadataQuery(() => spaceId);
  const isAdmin = $derived(metaQuery.data?.isAdmin ?? false);

  // The Discord bridge is a Roomy Pro feature; the badge says which tier the
  // caller is on before the section is expanded.
  const flagsQuery = createFeatureFlagsQuery();
  const proEnabled = $derived(
    flagsQuery.data?.flags.includes("pro-subscription") ?? false,
  );

  // Sections expand independently. Bluesky starts open: it is the one
  // integration a space can use without a bridge deployment.
  let blueskyOpen = $state(true);
  let discordOpen = $state(false);
  let matrixOpen = $state(false);
</script>

<div class="max-w-2xl">
  {#if metaQuery.isPending}
    <p class="text-sm text-base-400">Loading…</p>
  {:else if metaQuery.isLoadingError}
    <p class="text-sm text-base-500 dark:text-base-400">
      Couldn't load this space's settings right now.
    </p>
  {:else if isAdmin}
    <div class="flex flex-col">
      <IntegrationSection
        title="Bluesky"
        description="Publish this space's profile under the space's own Bluesky account."
        bind:open={blueskyOpen}
      >
        <BlueskySection />
      </IntegrationSection>

      <IntegrationSection
        title="Discord"
        description="Relay this space's channels and messages to a Discord server."
        bind:open={discordOpen}
      >
        {#snippet badge()}
          {#if proEnabled}
            <Badge variant="primary">Pro</Badge>
          {:else}
            <Badge variant="secondary">
              free up to {FREE_BRIDGE_MEMBER_LIMIT} members
            </Badge>
          {/if}
        {/snippet}
        <DiscordBridgeSection />
      </IntegrationSection>

      <IntegrationSection
        title="Matrix"
        description="Relay a Matrix room or space into this space's channels, and this space's messages back to Matrix."
        bind:open={matrixOpen}
      >
        <MatrixSection {spaceId} />
      </IntegrationSection>
    </div>
  {:else}
    <div class="flex flex-col items-center gap-4 py-12">
      <p class="text-sm text-base-500 dark:text-base-400">
        You don't have permission to manage this space's integrations.
      </p>
    </div>
  {/if}
</div>
