<script lang="ts">
  import { onNavigate } from "$app/navigation";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { currentRoomState } from "./current-room.svelte";
  import { currentSpaceState } from "./current-space.svelte";
  import { createFeatureFlagsQuery } from "$lib/queries/feature-flags";
  import { IconSearch, IconX } from "@roomy/design/icons";
  import { searchTerm } from "./search-term.svelte";

  // Search feature flag: gates the whole navbar search entry point.
  // All flags default false.
  const flagsQuery = createFeatureFlagsQuery();
  const searchEnabled = $derived(
    flagsQuery.data?.flags.includes("search") ?? false,
  );
  // Context the search will be scoped to: inside a room the search is
  // room-scoped, on a space page space-scoped (the room name only applies
  // when [room] is actually in the URL), and away from spaces it searches
  // across every joined space (the directory).
  const scope = $derived.by(() => {
    const params = page.params as { space?: string; room?: string };
    if (params.space && params.room) return "room";
    if (params.space) return "space";
    return "directory";
  });

  // True on the search result pages themselves: the navbar searchbar is
  // replaced by a close (X) button that navigates back to the room, the
  // space index, or the directory — wherever the search was launched from.
  const onSearchPage = $derived(
    page.url.pathname.endsWith("/search"),
  );

  const scopeLabel = $derived.by(() => {
    const params = page.params as { space?: string; room?: string };
    if (params.space && params.room) {
      return currentRoomState.value?.name ?? "This room";
    }
    if (params.space) {
      return currentSpaceState.value?.name ?? "This space";
    }
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
  // Navigating to a search page keeps the term: the page re-seeds it from
  // `?q=` (and a same-page re-submit must not blank the input).
  onNavigate((navigation) => {
    expanded = false;
    if (!navigation.to?.url.pathname.endsWith("/search")) {
      searchTerm.input = "";
    }
  });

  // Tabbing away just hides the expanded mobile searchbar; the typed value
  // survives until navigation (blur doesn't reset it).
  let searchInput = $state<HTMLInputElement>();
  function collapse() {
    if (!expanded) return;
    expanded = false;
    searchInput?.blur();
  }

  // Submit navigates to the search page for the current scope with the term
  // as `?q=` — the pages read the query string as their source of truth, so
  function submit(e: SubmitEvent | KeyboardEvent) {
    e.preventDefault();
    const term = searchTerm.input.trim();
    if (!term) return;

    const params = page.params as { space?: string; room?: string };
    const path =
      scope === "room"
        ? `/${params.space}/${params.room}/search`
        : scope === "space"
          ? `/${params.space}/search`
          : "/search";
    const target = `${path}?q=${encodeURIComponent(term)}`;
    expanded = false;
    goto(target);
  }

  // Close button on the search result pages: navigate back to the room,
  // the space index, or the directory — wherever the search was launched
  // from. The search pages are reached from the navbar searchbar, so the
  // scope at submit time is the same scope the page is showing.
  function closeSearch() {
    const params = page.params as { space?: string; room?: string };
    const path =
      scope === "room"
        ? `/${params.space}/${params.room}`
        : scope === "space"
          ? `/${params.space}`
          : "/";
    goto(path);
  }
</script>

{#if searchEnabled}
  {#if onSearchPage}
    <!-- On the search result pages the navbar searchbar takes over the
         whole navbar: the magnifier sits inside the bar, the page title
         ("Search <space>", "Search in <room>", …) is the placeholder, and
         the X closes search and navigates back to wherever the search was
         launched from. The term is shared with SearchResultsList via
         `searchTerm` — the URL `?q=` is the seed, this input is the live
         source. -->
    <form
      class="relative flex items-center flex-1 min-w-0 -ml-2"
      onsubmit={submit}
    >
      <IconSearch class="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-base-400" />
      <input
        bind:this={searchInput}
        bind:value={searchTerm.input}
        type="search"
        placeholder={searchTerm.placeholder}
        aria-label="Search"
        class="w-full ring-1 ring-inset ring-base-300 dark:ring-base-700 focus:ring-2 focus:ring-accent-500 bg-base-100 dark:bg-base-800/50 focus:bg-accent-400/5 dark:focus:bg-accent-600/5 text-base-900 dark:text-base-100 placeholder:text-base-400 dark:placeholder:text-base-500 rounded-xl pl-8 pr-8 py-1.5 text-sm outline-none border-0 transition-colors"
      />
      <button
        type="button"
        class="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 cursor-pointer text-base-500 hover:text-base-800 dark:hover:text-base-200 rounded-lg"
        aria-label="Close search"
        title="Close search"
        onclick={closeSearch}
      >
        <IconX class="size-4" />
      </button>
    </form>
  {:else}
    <!-- Collapsed search icon: shown until the navbar container is wide
         enough for the searchbar (the sidebar is visible from 640px, so
         the navbar container only reaches 640px once the viewport is
         wider than that). -->
    <button
      type="button"
      class="@min-[40rem]:hidden shrink-0 p-1 cursor-pointer text-base-700 dark:text-base-200 rounded-lg hover:bg-base-200/50 dark:hover:bg-base-900/30"
      class:hidden={expanded}
      aria-label="Search"
      title="Search {scopeLabel}"
      onclick={() => (expanded = true)}
    >
      <IconSearch class="size-5" />
    </button>

    <!-- Navbar-wide search UI: on narrow containers the expandable
         searchbar, on wide containers the fixed-width searchbar at the
         right edge of the navbar. The breakpoint is a container query
         (40rem = 640px) because the navbar's actual width depends on
         whether the sidebar is visible, not on the viewport width. -->
    <div
      class={[
        "flex items-center",
        expanded ? "absolute inset-0 px-2 @min-[40rem]:static" : "hidden @min-[40rem]:flex",
      ].join(" ")}
    >
      <!-- Expanded searchbar: takes up the whole navbar, so MainLayout
           hides the page-provided navbar content while it is open. -->
      <div class="@min-[40rem]:hidden flex items-center w-full" class:hidden={!expanded}>
        <form class="relative w-full" onsubmit={submit}>
          <IconSearch class="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-base-400" />
          <input
            bind:this={searchInput}
            bind:value={searchTerm.input}
            type="search"
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
        </form>
      </div>

      <!-- Wide container: fixed-width searchbar on the right side of the navbar -->
      <div class="hidden @min-[40rem]:block">
        <form class="relative w-56" onsubmit={submit}>
          <IconSearch class="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-base-400" />
          <input
            bind:this={searchInput}
            bind:value={searchTerm.input}
            type="search"
            placeholder={"Search " + scopeLabel}
            aria-label="Search"
            class="w-full ring-1 ring-inset ring-base-300 dark:ring-base-700 focus:ring-2 focus:ring-accent-500 bg-base-100 dark:bg-base-800/50 focus:bg-accent-400/5 dark:focus:bg-accent-600/5 text-base-900 dark:text-base-100 placeholder:text-base-400 dark:placeholder:text-base-500 rounded-xl pl-8 pr-3 py-1.5 text-sm outline-none border-0 transition-colors"
          />
        </form>
      </div>
    </div>

  {/if}
{/if}
