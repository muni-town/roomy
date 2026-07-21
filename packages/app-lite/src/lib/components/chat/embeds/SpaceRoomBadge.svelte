<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import { cache } from "@roomy-space/sdk";
  import { queryClient } from "$lib/client";
  import { px } from "$lib/auth.svelte";
  import { IconNeedleThread, IconChevronRight } from "@roomy/design/icons";
  import SpaceAvatar from "@roomy/design/components/spaces/SpaceAvatar.svelte";
  import { resolveBlobUrl } from "$lib/utils";
  import { currentSpaceState } from "$lib/components/layout/current-space.svelte";

  let {
    spaceId,
    roomId,
    href,
    linkText,
  }: {
    spaceId: string;
    roomId?: string;
    href: string;
    /** Explicit link text from a markdown link like [text](/did:plc:xxx). When set, use this instead of space/room names. */
    linkText?: string;
  } = $props();

  const { queryKey } = cache;

  // Use the global queryClient directly (not Svelte context) since this
  // component is mounted imperatively via mount() rather than in the template.
  // Use the lightweight summary queries instead of getMetadata. A badge only
  // needs name/avatar/kind — the full getMetadata handlers run the sidebar
  // tree, recent threads, and per-thread access checks (~250 SQL statements
  // for room.getMetadata), which is the load spike seen after the
  // "enrich internal links" change. Summary queries are one SQL row + one
  // access check. The query keys are distinct from getMetadata so they
  // don't collide with / invalidate the sidebar's full-metadata cache.
  const spaceQuery = createQuery(
    () => ({
      queryKey: queryKey("space.roomy.space.getSpaceSummary", { spaceId }),
      queryFn: () =>
        px().query("space.roomy.space.getSpaceSummary", {
          spaceId,
        }),
    }),
    () => queryClient,
  );

  const roomQuery = createQuery(
    () => ({
      queryKey: queryKey("space.roomy.room.getRoomSummary", { roomId: roomId ?? "" }),
      queryFn: () =>
        px().query("space.roomy.room.getRoomSummary", { roomId: roomId ?? "" }),
      enabled: !!roomId,
    }),
    () => queryClient,
  );

  const spaceName = $derived(spaceQuery.data?.name ?? spaceId);
  const spaceAvatar = $derived(spaceQuery.data?.avatar);
  const roomName = $derived(roomQuery.data?.name);
  const roomKind = $derived(roomQuery.data?.kind);

  // Don't show the space badge if this is the current space
  const isCurrentSpace = $derived(currentSpaceState.value?.id === spaceId);
</script>

<a
  {href}
  class="mention not-prose !no-underline whitespace-nowrap"
>
  {#if !isCurrentSpace}
    <span class="inline-block align-middle">
      <SpaceAvatar
        src={resolveBlobUrl(spaceAvatar)}
        id={spaceId}
        name={spaceName}
        size={14}
      />
    </span>
    <span class="align-middle">{linkText ?? spaceName}</span>
    {#if roomId}
      <IconChevronRight class="opacity-40 size-3 inline align-middle" />
    {/if}
  {:else if linkText}
    <span class="align-middle">{linkText}</span>
  {/if}
  {#if roomId}
    {#if roomKind === "thread"}
      <IconNeedleThread class="opacity-60 size-3.5 inline align-middle" />
    {:else}
      <span class="opacity-60 align-middle">#</span>
    {/if}
    <span class="align-middle">{roomName ?? roomId}</span>
  {/if}
</a>
