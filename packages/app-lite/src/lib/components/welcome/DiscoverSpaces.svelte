<script lang="ts">
  import { createSpaceMetadataQuery } from "$lib/queries/space-metadata";
  import { resolveBlobUrl } from "$lib/utils";
  import SpaceAvatar from "@roomy/design/components/spaces/SpaceAvatar.svelte";
  import ErrorMessage from "@roomy/design/components/helper/ErrorMessage.svelte";
  import { IconX } from "@roomy/design/icons";
  import LoadingSpinner from "@roomy/design/components/helper/LoadingSpinner.svelte";
  import { fade } from "svelte/transition";

  /**
   * A single discoverable-space card. Fetches its own metadata via the
   * `space.roomy.space.getMetadata` XRPC query (public spaces allow
   * anonymous read access). Renders the space description instead of an
   * unread count, and is dismissable via the X button.
   */
  let {
    spaceId,
    onDismiss,
  }: {
    spaceId: string;
    onDismiss: (id: string) => void;
  } = $props();

  const metaQuery = createSpaceMetadataQuery(() => spaceId, {
    enabled: !!spaceId,
  });
</script>

<div class="relative snap-start shrink-0 w-72 flex" transition:fade={{ duration: 200 }}>
  <!-- Dismiss button (on the card edge; container has pt to avoid clipping) -->
  <button
    type="button"
    aria-label="Dismiss"
    class="absolute -top-2 -right-2 z-10 size-6 rounded-full bg-base-200 dark:bg-base-700 text-base-500 dark:text-base-300 flex items-center justify-center hover:bg-base-300 dark:hover:bg-base-600 hover:text-base-700 dark:hover:text-base-100 transition-colors shadow-sm"
    onclick={() => onDismiss(spaceId)}
  >
    <IconX class="size-3.5" />
  </button>

  <a
    href={`/${spaceId}`}
    class="h-full w-full flex flex-col items-center gap-3 p-5 rounded-2xl bg-base-50/60 dark:bg-base-800/20 border border-base-200/60 dark:border-base-700/30 text-center transition-colors hover:bg-accent-50 dark:hover:bg-accent-900/20 hover:border-accent-300 dark:hover:border-accent-700/50"
  >
    {#if metaQuery.isPending}
      <div class="flex items-center justify-center" style="width: 88px; height: 88px;">
        <LoadingSpinner size={24} />
      </div>
      <div class="h-3 w-24 rounded-full bg-base-200 dark:bg-base-700 animate-pulse"></div>
      <div class="h-2 w-40 rounded-full bg-base-100 dark:bg-base-800 animate-pulse"></div>
    {:else if metaQuery.isError}
      <div class="flex items-center justify-center" style="width: 88px; height: 88px;">
        <ErrorMessage message="Unable to load space" class="py-4" />
      </div>
    {:else if metaQuery.data}
      <SpaceAvatar
        src={resolveBlobUrl(metaQuery.data.avatar)}
        id={spaceId}
        name={metaQuery.data.name ?? undefined}
        size={88}
        shape="circle"
      />
      <h3 class="font-semibold text-sm text-base-900 dark:text-base-100 truncate w-full">
        {metaQuery.data.name ?? "Unnamed Space"}
      </h3>
      <p class="text-xs text-base-500 dark:text-base-400 leading-relaxed line-clamp-3 min-h-[3rem]">
        {metaQuery.data.description ?? "A space on Roomy."}
      </p>
    {/if}
  </a>
</div>