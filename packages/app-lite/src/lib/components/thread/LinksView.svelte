<script lang="ts">
  import { page } from "$app/state";
  import { createRoomLinksQuery, type Link } from "$lib/queries/links";
  import LinkViewShell from "@roomy/design/components/content/thread/linkView/LinkView.svelte";
  import type { LinkInfo } from "@roomy/design/components/content/thread/linkView/types.ts";
  import ErrorMessage from "@roomy/design/components/helper/ErrorMessage.svelte";
  import { createSpaceMetadataQuery } from "$lib/queries/space-metadata";
  import { createFeatureFlagsQuery } from "$lib/queries/feature-flags";
  import { createSpaceCard } from "$lib/mutations/space-card";
  import { saveToPersonalCollection } from "$lib/mutations/semble-personal";
  import { guardedXrpc } from "$lib/scope-guard";
  import { showScopeConsentDialogue } from "$lib/scope-consent-dialogue";
  import { toast } from "@foxui/core";

  let {
    emptyMessage = "No links shared yet",
  }: { emptyMessage?: string } = $props();

  const roomId = $derived(page.params.room!);
  const spaceId = $derived(page.params.space!);

  const linksQuery = createRoomLinksQuery(() => roomId);

  let links = $derived<LinkInfo[]>(
    (linksQuery.data?.pages.flatMap((p) => p.links) ?? []).map(mapLink),
  );

  // The mutations take the wire `Link` (with its `embed` in the wire shape),
  // not the reduced `LinkInfo` the card renders. The card hands back only a
  // URL, so keep the original wire object reachable by URL. The index is
  // URL-deduped server-side, so `url` is a key.
  const wireLinksByUrl = $derived(
    new Map(
      (linksQuery.data?.pages.flatMap((p) => p.links) ?? []).map((l) => [
        l.url,
        l,
      ]),
    ),
  );

  let hasMore = $derived(linksQuery.hasNextPage ?? false);

  function loadMore() {
    linksQuery.fetchNextPage();
  }

  // Space admin status gates the space-card action (it writes through the
  // space's arbiter, which the space's policy pipeline grants its admins).
  const spaceMetaQuery = createSpaceMetadataQuery(() => spaceId);
  const isAdmin = $derived(spaceMetaQuery.data?.isAdmin ?? false);
  // Both Semble actions are rollout-gated behind the same flag as the chat
  // toolbar's, so the links view offers nothing until it is enabled.
  const flagsQuery = createFeatureFlagsQuery();
  const sembleIntegrationEnabled = $derived(
    flagsQuery.data?.flags.includes("semble-integration") ?? false,
  );
  const canCreateSpaceCard = $derived(isAdmin && sembleIntegrationEnabled);
  // Saving to the viewer's own collection is not an admin power — it writes to
  // their own repo — so the flag alone opens it to every member.
  const canSaveToCollection = $derived(sembleIntegrationEnabled);

  /**
   * Create a Semble space card from the link, on the space's own account.
   *
   * Same write and consent flow as the chat toolbar's action
   * (`ChatMessage.handleCreateCard`): the arbiter proxy path, under the `base`
   * tier.
   */
  async function handleCreateCard(link: LinkInfo) {
    const wire = wireLinksByUrl.get(link.url);
    if (!wire) return;
    try {
      await guardedXrpc(() => createSpaceCard(spaceId, wire), {
        requiredTier: "base",
        prompt: (tier) =>
          showScopeConsentDialogue(tier, {
            title: "Create Space cards",
            description:
              "Creating a card in this Space writes through the Space's " +
              "arbiter. Roomy needs your permission for this action — the " +
              "consent screen will show the exact access it requests.",
          }),
      });
      toast.success("Space card created.");
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Failed to create space card.",
      );
    }
  }

  /**
   * Save the link to the viewer's own Semble collection.
   *
   * Writes to the caller's own repo, so it needs `repo:network.cosmik.card?
   * action=create` — the `semble` tier. The first attempt fails the PDS scope
   * check and `guardedXrpc` turns that into the consent dialogue, exactly as
   * `ChatMessage.handleSaveToCollection` does.
   */
  async function handleSaveToCollection(link: LinkInfo) {
    const wire = wireLinksByUrl.get(link.url);
    if (!wire) return;
    try {
      await guardedXrpc(() => saveToPersonalCollection(wire), {
        requiredTier: "semble",
        prompt: (tier) =>
          showScopeConsentDialogue(tier, {
            title: "Save to your Semble collection",
            description:
              "Saving this link writes a card to your own Semble " +
              "collection, in your own ATProto account. Roomy needs your " +
              "permission for this action — the consent screen will show " +
              "the exact access it requests.",
          }),
      });
      toast.success("Saved to your Semble collection.");
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Failed to save to your collection.",
      );
    }
  }

  function mapLink(l: Link): LinkInfo {
    const embed = l.embed;
    const base = { url: l.url, timestamp: l.timestamp };
    if (!embed) return base;
    return {
      ...base,
      embed: {
        title: embed.t,
        description: embed.d,
        image: embed.imgs?.[0]?.u ?? embed.thumb?.u,
        video: embed.vid?.u,
        thumbnail: embed.thumb?.u,
        provider: embed.p?.n,
        author: embed.au?.n,
      },
    };
  }
</script>

{#if linksQuery.isLoadingError}
  <ErrorMessage
    message={linksQuery.error.message}
    class="h-full w-full justify-center"
  />
{:else}
  <div class="flex flex-col h-full min-h-0">
    <div class="flex-1 min-h-0">
      <LinkViewShell
        {links}
        {emptyMessage}
        {loadMore}
        {hasMore}
        loading={linksQuery.isPending && !linksQuery.data}
        onCreateCard={canCreateSpaceCard ? handleCreateCard : undefined}
        onSaveToCollection={canSaveToCollection
          ? handleSaveToCollection
          : undefined}
      />
    </div>
  </div>
{/if}
