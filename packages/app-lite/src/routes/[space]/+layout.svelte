<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { page } from "$app/state";
  import { useTopicSubscription } from "@roomy-space/sdk/svelte";
  import type { Topic } from "@roomy-space/sdk/svelte";
  import { sync_ } from "$lib/sync.svelte";
  import SpaceSidebar from "$lib/components/sidebar/SpaceSidebar.svelte";
  import { sidebarOverride, setSidebarContent } from "$lib/components/layout/sidebar.svelte";
  import { setCurrentSpace, setLastActiveSpaceId } from "$lib/components/layout/current-space.svelte";
  import JoinSpaceModal from "$lib/components/layout/JoinSpaceModal.svelte";
  import { createSpaceMetadataQuery } from "$lib/queries/space-metadata";
  import { preloadRoomMessages } from "$lib/preload";
  import SeoMeta from "$lib/components/seo/SeoMeta.svelte";

  let { children } = $props();

  const spaceId = $derived(page.params.space!);

  const metaQuery = createSpaceMetadataQuery(() => spaceId);

  import { base } from "$app/paths";
  import { resolveBlobUrl } from "$lib/utils";

  const defaultFavicon = `${base}/favicon.png`;

  // Expose current space info for the mobile nav bar (RoomyHomeCard)
  $effect(() => {
    setCurrentSpace(
      metaQuery.data
        ? { id: spaceId, name: metaQuery.data.name, avatar: metaQuery.data.avatar }
        : null,
    );
    return () => setCurrentSpace(null);
  });

  // Track the last active space so user settings "Back" can return to it.
  $effect(() => {
    if (metaQuery.data) {
      setLastActiveSpaceId(spaceId);
    }
  });

  // Background data preloading: once this space's sidebar (getSpaceMetadata)
  // is loaded, prefetch the first page of messages for a prioritized, capped
  // set of rooms so navigating into one renders instantly. The currently-open
  // room is ranked first (reopening it is the most likely next action), then
  // unread rooms. Idempotent via ensureQueryData. Reads the active room
  // untracked so this effect stays keyed on sidebar availability, not on every
  // room change.
  $effect(() => {
    if (metaQuery.data) {
      untrack(() => {
        void preloadRoomMessages(spaceId, {
          preferredFirstId: sync_.activeRoomId ?? undefined,
        });
      });
    }
  });

  // Dynamic title & favicon based on the currently active space.
  $effect(() => {
    const spaceName = metaQuery.data?.name;
    const spaceAvatar = metaQuery.data?.avatar;

    // Update document title
    document.title = spaceName ? `${spaceName} - Roomy` : "Roomy";

    // Update favicon link
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.append(link);
    }

    if (spaceAvatar) {
      link.href = resolveBlobUrl(spaceAvatar) ?? "";
    } else {
      link.href = defaultFavicon;
    }

    // Cleanup: reset title and favicon when leaving this space
    return () => {
      document.title = "Roomy";
      if (link) link.href = defaultFavicon;
    };
  });

  // Show join modal when we have metadata and user is not a member.
  // While loading, render the layout underneath (spinner is inside the modal).
  const showJoinModal = $derived(
    metaQuery.isSuccess && metaQuery.data && !metaQuery.data.isMember,
  );

  useTopicSubscription(
    () => sync_.ctx?.topicManager ?? null,
    () => [{ kind: "space", id: spaceId } satisfies Topic],
  );

  // Set sidebar content — clean up when leaving this layout
  onMount(() => {
    setSidebarContent(spaceSidebar);
    return () => setSidebarContent(undefined);
  });
</script>

<SeoMeta
  title={metaQuery.data?.name ? `${metaQuery.data.name} - Roomy` : "Roomy"}
  description={metaQuery.data?.description}
  image={metaQuery.data?.avatar ? resolveBlobUrl(metaQuery.data.avatar) : undefined}
  url={page.url.origin ? `${page.url.origin}/${spaceId}` : undefined}
/>

<div class="h-full dark:bg-base-900/20 text-base-800 dark:text-base-200">
  {@render children()}
</div>

{#snippet spaceSidebar()}
  {#if sidebarOverride.content}
    {@render sidebarOverride.content?.()}
  {:else}
    {#key spaceId}
      <SpaceSidebar {spaceId} />
    {/key}
  {/if}
{/snippet}

{#if showJoinModal}
  <JoinSpaceModal {spaceId} />
{/if}
