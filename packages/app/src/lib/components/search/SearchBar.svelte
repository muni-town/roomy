<script lang="ts">
  import Icon from "@iconify/svelte";
  import SearchResults from "./SearchResults.svelte";
  import { focusOnRender } from "$lib/actions/useFocusOnRender.svelte";
  import { findMessages } from "./search.svelte";

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
    console.log("result clicked", messageId);
    // Hide search results
    // TODO: scroll to message
    showSearchResults = false;

    // // Find the message in the timeline to get its index
    // if (timeline) {
    //   // Get the timeline IDs - this returns an array, not a Promise
    //   const ids = timeline;

    //   if (!messageId.includes("co_")) {
    //     return;
    //   }

    //   const messageIndex = ids?.indexOf(messageId as `co_${string}`);
    //   console.log("message index", messageIndex);
    //   if (messageIndex !== -1) {
    //     virtualizer?.scrollToIndex(messageIndex);
    //   } else {
    //     console.error("Message not found in timeline:", messageId);
    //   }
    // } else {
    //   console.error("No active channel");
    // }
  }

  async function updateSearchResults(query: string) {
    if(!query.length) {
      searchResults = [];
      showSearchResults = false;
      return;
    }
    const results = await findMessages(spaceId, query);
    console.log("results", results);
    searchResults = results as string[];
    showSearchResults = results.length > 0;
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
    <div class="absolute z-20 w-full">
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
{/if}
