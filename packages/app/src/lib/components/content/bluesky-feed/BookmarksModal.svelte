<script lang="ts">
  import BookmarksList from "./BookmarksList.svelte";
  import Icon from "@iconify/svelte";

  let {
    show,
    bookmarks,
    objectId,
    onClose,
    onViewThread,
  }: {
    show: boolean;
    bookmarks: any[];
    objectId?: string;
    onClose: () => void;
    onViewThread: (postUri: string) => void;
  } = $props();

</script>

{#if show}
  <div
    class="fixed inset-0 bg-black/50 z-50 flex items-center justify-center"
    onclick={onClose}
  >
    <div
      class="bg-white dark:bg-base-800 rounded-lg shadow-xl w-full max-w-4xl h-[80vh] flex flex-col"
      onclick={(e) => e.stopPropagation()}
    >
      <div class="flex-shrink-0 p-4 border-b border-base-300 dark:border-base-700 flex items-center justify-between">
        <h2 class="text-lg font-semibold flex items-center gap-2">
          <Icon icon="mdi:bookmark" class="text-yellow-500" />
          Bookmarked Threads ({bookmarks?.length || 0})
        </h2>
        <button
          onclick={onClose}
          class="p-1 rounded-full hover:bg-base-100 dark:hover:bg-base-700"
        >
          <Icon icon="mdi:close" class="size-5" />
        </button>
      </div>
      <div class="flex-1 overflow-hidden">
        <BookmarksList {bookmarks} {objectId} {onViewThread} />
      </div>
    </div>
  </div>
{/if}
