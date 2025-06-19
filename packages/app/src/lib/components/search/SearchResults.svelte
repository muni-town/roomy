<script lang="ts">
  import Icon from "@iconify/svelte";
  import type { Message } from "$lib/jazz/schema";
  import SearchResult from "./SearchResult.svelte";
  import { co } from "jazz-tools";

  let {
    messages = [],
    query = "",
    onMessageClick,
    onClose,
  }: {
    messages: string[];
    query: string;
    onMessageClick: (messageId: string) => void;
    onClose: () => void;
  } = $props();
  
  console.log("SearchResults component rendered with:", messages.length, "messages, query:", query);

  // Highlight the search term in the message content
  function highlightSearchTerm(content: string, searchTerm: string): string {
    if (!searchTerm) return content;

    return content.replaceAll(
      searchTerm,
      `<mark class="bg-primary/30 text-base-content">${searchTerm}</mark>`,
    );
  }

  // Format the message preview with highlighted search term
  function formatMessagePreview(message: co.loaded<typeof Message>): string {
    try {
      const htmlContent = message.content ?? "";
      return highlightSearchTerm(htmlContent, query);
    } catch (error) {
      console.error(error);
      return "Unable to display message content";
    }
  }
</script>

<div
  class="search-results max-w-full bg-base-100 border border-base-300 rounded-lg shadow-lg w-full max-h-[60vh] overflow-auto"
>
  <div
    class="sticky top-0 bg-base-100 p-3 border-b border-base-300 flex justify-between items-center z-10"
  >
    <h3 class="font-bold text-base-content">
      Search Results {#if messages.length > 0}<span class="text-sm font-normal"
          >({messages.length})</span
        >{/if}
    </h3>
    <button class="btn btn-ghost btn-sm btn-circle" onclick={onClose}>
      <Icon icon="tabler:x" />
    </button>
  </div>

  {#if messages.length === 0}
    <div class="p-6 text-center text-base-content/70">
      <Icon icon="tabler:search-off" class="text-4xl mb-2" />
      <p>No messages found matching "{query}"</p>
    </div>
  {:else}
    <ul class="divide-y divide-base-300">
      {#each messages as message}
        <SearchResult
          messageId={message}
          {onMessageClick}
          {formatMessagePreview}
        />
      {/each}
    </ul>
  {/if}
</div>
