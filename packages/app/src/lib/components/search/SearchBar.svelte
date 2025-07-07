<script lang="ts">
  import Icon from "@iconify/svelte";
  import SearchResults from "./SearchResults.svelte";
  import { focusOnRender } from "$lib/actions/useFocusOnRender.svelte";
  import { findMessages } from "./search.svelte";
  import { chatArea } from "../ChatArea.svelte";

  let {
    spaceId,
    showSearch = $bindable(false),
  }: {
    spaceId: string;
    showSearch: boolean;
  } = $props();

  let searchQuery = $state("");
  let searchResults: string[] = $state([]);
  let showSearchResults = $state(false);

  // Function to handle search result click
  function handleSearchResultClick(messageId: string) {
    // Hide search results
    // TODO: scroll to message
    showSearchResults = false;
    chatArea.scrollToMessage?.(messageId);
  }

  async function updateSearchResults(query: string) {
    console.log("updateSearchResults called with query:", query);
    if (!query.length) {
      searchResults = [];
      showSearchResults = false;
      console.log("Empty query, hiding results");
      return;
    }
    const results = await findMessages(spaceId, query);
    console.log("Search results from findMessages:", results);
    searchResults = results as string[];
    showSearchResults = results.length > 0;
    console.log(
      "showSearchResults set to:",
      showSearchResults,
      "with",
      searchResults.length,
      "results",
    );
  }
</script>

<div
  class="flex items-center border-b border-gray-200 dark:border-gray-700 px-2 py-1"
>
  <Icon icon="tabler:search" class="text-base-content/50 mr-2" />
  <input
    type="text"
    placeholder="Search messages..."
    bind:value={searchQuery}
    use:focusOnRender
    class="input input-sm input-ghost w-full focus:outline-none"
    autoComplete="off"
    oninput={() => {
      updateSearchResults(searchQuery);
    }}
  />
  <button
    class="btn btn-ghost btn-sm btn-circle"
    onclick={() => {
      searchQuery = "";
      showSearch = false;
      showSearchResults = false;
    }}
  >
    <Icon icon="tabler:x" class="text-base-content/50" />
  </button>
</div>

{#if showSearchResults}
  <div class="relative">
    <div class="absolute z-50 w-full bg-red-500 p-2 border-2 border-blue-500">
      <div class="bg-white">
        <SearchResults
          messages={searchResults}
          query={searchQuery}
          onMessageClick={handleSearchResultClick}
          onClose={() => {
            showSearchResults = false;
          }}
        />
      </div>
    </div>
  </div>
{:else}
  <div class="text-xs text-gray-500">
    Search results hidden (showSearchResults: {showSearchResults})
  </div>
{/if}
