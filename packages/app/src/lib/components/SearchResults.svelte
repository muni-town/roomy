<script lang="ts">
  import Icon from "@iconify/svelte";
  import AvatarImage from "$lib/components/AvatarImage.svelte";
  import { getContentHtml } from "$lib/tiptap/editor";
  import type { Message } from "$lib/jazz/schema";
  import SearchResult from "./search/SearchResult.svelte";

  let {
    messages = [],
    query = "",
    onMessageClick,
    onClose,
  }: {
    messages: (typeof Message)[];
    query: string;
    onMessageClick: (messageId: string) => void;
    onClose: () => void;
  } = $props();

  // Highlight the search term in the message content
  function highlightSearchTerm(content: string, searchTerm: string): string {
    if (!searchTerm) return content;

    const regex = new RegExp(`(${searchTerm})`, "gi");
    return content.replace(
      regex,
      '<mark class="bg-primary/30 text-base-content">$1</mark>',
    );
  }

  // Format the message preview with highlighted search term
  function formatMessagePreview(message: typeof Message): string {
    try {
      // const bodyContent = JSON.parse(message.body);
      // const htmlContent = getContentHtml(bodyContent);\
      const htmlContent = message.content;
      console.log(message.content);
      return highlightSearchTerm(htmlContent, query);
    } catch (error) {
      console.error(error);
      return "Unable to display message content";
    }
  }
</script>



<div
  class="search-results bg-base-100 border border-base-300 rounded-lg shadow-lg w-full max-h-[60vh] overflow-auto"
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
        <SearchResult message={message} onMessageClick={onMessageClick} formatMessagePreview={formatMessagePreview} />
      {/each}
    </ul>
  {/if}
</div>

<style>
  .search-results {
    max-width: 100%;
  }

  :global(.search-results mark) {
    padding: 0 2px;
    border-radius: 2px;
  }
</style>
