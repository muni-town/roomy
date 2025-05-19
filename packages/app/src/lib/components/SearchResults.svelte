<script lang="ts">
  import Icon from "@iconify/svelte";
  import AvatarImage from "$lib/components/AvatarImage.svelte";
  import { getProfile } from "$lib/profile.svelte";
  import { getContentHtml } from "$lib/tiptap/editor";
  import type { Message } from "@roomy-chat/sdk";
  import { formatDistanceToNow } from "date-fns";

  let {
    messages = [],
    query = "",
    onMessageClick,
    onClose,
  }: {
    messages: Message[];
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
  function formatMessagePreview(message: Message): string {
    try {
      const bodyContent = JSON.parse(message.bodyJson);
      const htmlContent = getContentHtml(bodyContent);
      return highlightSearchTerm(htmlContent, query);
    } catch (error) {
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
        <li class="hover:bg-base-200 cursor-pointer transition-colors">
          <button
            type="button"
            class="p-3 flex items-start gap-2"
            onclick={() => {
              // Just call onMessageClick and don't try to scroll directly from here
              // This will avoid the postMessage error
              onMessageClick(message.id);
            }}
          >
            {#await getProfile(message.authors((x) => x.get(0))) then profile}
              <AvatarImage
                handle={profile.handle || ""}
                avatarUrl={profile.avatarUrl}
                className="w-8 h-8"
              />
              <div class="flex-1 min-w-0">
                <div class="flex justify-between items-center mb-1">
                  <span class="font-medium text-base-content"
                    >{profile.handle || "Unknown"}</span
                  >
                  <span class="text-xs text-base-content/60">
                    {message.createdDate
                      ? formatDistanceToNow(message.createdDate, {
                          addSuffix: true,
                        })
                      : ""}
                  </span>
                </div>
                <div
                  class="text-sm text-base-content/80 line-clamp-2 break-words"
                >
                  {@html formatMessagePreview(message)}
                </div>
              </div>
            {/await}
          </button>
        </li>
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
