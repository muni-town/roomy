<script lang="ts">
  /**
   * DiscoverSpaceCard — one card's body in the welcome page's discover strip:
   * the space's avatar, name and description, in its resolved, pending or
   * failed state.
   *
   * Presentational only: everything it renders arrives on `space`. The card
   * frame and its dismiss button belong to the strip ({@link
   * DiscoverSpacesSection}), which is what keeps the frame identical across
   * whichever body a caller supplies.
   */
  import SpaceAvatar from "../spaces/SpaceAvatar.svelte";
  import ErrorMessage from "../helper/ErrorMessage.svelte";
  import LoadingSpinner from "../helper/LoadingSpinner.svelte";
  import { resolveBlobUrl } from "../../utils/index.js";
  import type { DiscoverableSpace } from "./types";

  let { space }: { space: DiscoverableSpace } = $props();
</script>

{#if space.pending}
  <div class="flex items-center justify-center" style="width: 88px; height: 88px;">
    <LoadingSpinner size={24} />
  </div>
  <div class="h-3 w-24 rounded-full bg-base-200 dark:bg-base-700 animate-pulse"></div>
  <div class="h-2 w-40 rounded-full bg-base-100 dark:bg-base-800 animate-pulse"></div>
{:else if space.failed}
  <div class="flex items-center justify-center" style="width: 88px; height: 88px;">
    <ErrorMessage message="Unable to load space" class="py-4" />
  </div>
{:else}
  <SpaceAvatar
    src={resolveBlobUrl(space.avatar)}
    id={space.id}
    name={space.name}
    size={88}
    shape="circle"
  />
  <h3 class="font-semibold text-sm text-base-900 dark:text-base-100 truncate w-full">
    {space.name ?? "Unnamed Space"}
  </h3>
  <p class="text-xs text-base-500 dark:text-base-400 leading-relaxed line-clamp-3 min-h-[3rem]">
    {space.description ?? "A space on Roomy."}
  </p>
{/if}
