<script lang="ts">
  import { onNavigate } from "$app/navigation";
  import { page } from "$app/state";
  import { currentRoomState } from "./current-room.svelte";
  import { createFeatureFlagsQuery } from "$lib/queries/feature-flags";
  import { IconSearch, IconX } from "@roomy/design/icons";

  // Search feature flag: gates the whole navbar search entry point, matching
  // the flag that previously gated the Explore tab. All flags default false.
  const flagsQuery = createFeatureFlagsQuery();
  const searchEnabled = $derived(
    flagsQuery.data?.flags.includes("search") ?? false,
  );

  // Context the search will be scoped to by default (placeholder display for
  // now — the actual scoped search + results UI ships next).
  const scopeLabel = $derived.by(() => {
    const params = page.params as { space?: string };
    if (params.space) return currentRoomState.value?.name ?? "This space";
    // The directory (homepage / space-less routes) searches across spaces.
    return "All spaces";
  });

  let {
    // Mobile: the collapsed search icon expands to a searchbar that takes
    // over the whole navbar. Bound by MainLayout so it can hide the
    // page-provided navbar content while the searchbar is open.
    expanded = $bindable(false),
  }: {
    expanded?: boolean;
  } = $props();

  // After a navigation, reset the expanded state and the typed value so the
  // searchbar doesn't linger over the next page's navbar. Client-side nav
  // keeps this component mounted (it lives in MainLayout), so hooking
  // navigation is required — an onMount cleanup would only fire on unmount.
  let query = $state("");
  onNavigate(() => {
    expanded = false;
    query = "";
  });

  // Tabbing away just hides the expanded mobile searchbar; the typed value
  // survives until navigation (blur doesn't reset it).
  let searchInput = $state<HTMLInputElement>();
  function collapse() {
    if (!expanded) return;
    expanded = false;
    searchInput?.blur();
  }
</script>

{#if searchEnabled}
  <!-- Mobile: collapsed search icon (top right) -->
  <button
    type="button"
    class="sm:hidden shrink-0 p-1 cursor-pointer text-base-700 dark:text-base-200 rounded-lg hover:bg-base-200/50 dark:hover:bg-base-900/30"
    class:hidden={expanded}
    aria-label="Search"
    title="Search {scopeLabel}"
    onclick={() => (expanded = true)}
  >
    <IconSearch class="size-5" />
  </button>

  <!-- Navbar-wide search UI: on mobile the expandable searchbar, on desktop
       the fixed-width searchbar at the right edge of the navbar -->
  <div
    class={[
      "flex items-center",
      expanded ? "absolute inset-0 px-2 sm:static" : "hidden sm:flex",
    ].join(" ")}
  >
    <!-- Mobile expanded searchbar: takes up the whole navbar, so MainLayout
         hides the page-provided navbar content while it is open. -->
    <div class="sm:hidden flex items-center w-full" class:hidden={!expanded}>
      <div class="relative w-full">
        <IconSearch class="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-base-400" />
        <input
          bind:this={searchInput}
          bind:value={query}
          type="text"
          placeholder={"Search " + scopeLabel}
          aria-label="Search"
          class="w-full ring-1 ring-inset ring-base-300 dark:ring-base-700 focus:ring-2 focus:ring-accent-500 bg-base-100 dark:bg-base-800/50 focus:bg-accent-400/5 dark:focus:bg-accent-600/5 text-base-900 dark:text-base-100 placeholder:text-base-400 dark:placeholder:text-base-500 rounded-xl pl-8 pr-8 py-1.5 text-sm outline-none border-0 transition-colors"
        />
        <button
          type="button"
          class="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 cursor-pointer text-base-500 hover:text-base-800 dark:hover:text-base-200 rounded-lg"
          aria-label="Close search"
          onclick={collapse}
        >
          <IconX class="size-4" />
        </button>
      </div>
    </div>

    <!-- Desktop: fixed-width searchbar on the right side of the navbar -->
    <div class="hidden sm:block">
      <div class="relative w-56">
        <IconSearch class="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-base-400" />
        <input
          bind:this={searchInput}
          bind:value={query}
          type="text"
          placeholder={"Search " + scopeLabel}
          aria-label="Search"
          class="w-full ring-1 ring-inset ring-base-300 dark:ring-base-700 focus:ring-2 focus:ring-accent-500 bg-base-100 dark:bg-base-800/50 focus:bg-accent-400/5 dark:focus:bg-accent-600/5 text-base-900 dark:text-base-100 placeholder:text-base-400 dark:placeholder:text-base-500 rounded-xl pl-8 pr-3 py-1.5 text-sm outline-none border-0 transition-colors"
        />
      </div>
    </div>
  </div>
{/if}
