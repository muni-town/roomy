<script lang="ts" generics="T extends unknown[]">
  import type { Snippet } from "svelte";
  import type { AsyncState } from "$lib/types/asyncState";
  import { Button } from "@fuxui/base";
  import IconMdiLoading from "~icons/mdi/loading";
  import IconTablerRefresh from "~icons/tabler/refresh";

  /**
   * QueryBoundary - A reusable boundary for LiveQuery results
   *
   * Handles three states:
   * 1. Loading - Shows a spinner (with optional delay to prevent flicker)
   * 2. Error - Shows error message with retry button
   * 3. Success - Renders the children snippet
   *
   * Note: Once svelte-check fully supports {#boundary} blocks, we can add
   * them here to catch rendering errors in child components. For now, this
   * handles query-level errors and loading states.
   */

  let {
    query,
    emptyMessage = "No results",
    showEmptyState = false,
    loadingDelay = 200,
    onRetry,
    children,
  }: {
    query: AsyncState<T>;
    emptyMessage?: string;
    showEmptyState?: boolean;
    loadingDelay?: number;
    onRetry?: () => void;
    children: Snippet;
  } = $props();

  // Delay showing loading to prevent flicker for fast queries
  let showLoading = $state(false);
  let loadingTimer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    if (query.status === "loading") {
      loadingTimer = setTimeout(() => (showLoading = true), loadingDelay);
    } else {
      showLoading = false;
    }
    return () => clearTimeout(loadingTimer);
  });
</script>

{#if query.status === "loading"}
  {#if showLoading}
    <div class="grid items-center justify-center h-full w-full min-h-32 bg-transparent">
      <IconMdiLoading font-size="2em" class="animate-spin text-base-600 dark:text-base-400" />
    </div>
  {/if}
{:else if query.status === "error"}
  <div class="flex flex-col items-center justify-center p-4 gap-2 min-h-32">
    <div class="text-base-900 dark:text-base-100 font-medium">
      Error loading data
    </div>
    <div class="text-sm text-base-600 dark:text-base-400 max-w-md text-center">
      {query.message || "An unexpected error occurred"}
    </div>
    {#if onRetry}
      <Button onclick={onRetry} variant="secondary" size="sm">
        <IconTablerRefresh class="w-4 h-4" />
        Retry
      </Button>
    {/if}
  </div>
{:else if query.status === "success" && query.data.length === 0 && showEmptyState}
  <div class="flex flex-col items-center justify-center p-4 min-h-32">
    <p class="text-base-600 dark:text-base-400">{emptyMessage}</p>
  </div>
{:else if query.status === "success"}
  {@render children()}
{/if}
