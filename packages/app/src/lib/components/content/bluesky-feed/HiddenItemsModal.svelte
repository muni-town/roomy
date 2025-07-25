<script lang="ts">
  import type { AtprotoFeedPost } from "$lib/utils/atprotoFeeds";
  import Icon from "@iconify/svelte";

  let {
    show,
    hiddenPosts,
    onClose,
    onUnhide,
  }: {
    show: boolean;
    hiddenPosts: AtprotoFeedPost[];
    onClose: () => void;
    onUnhide: (post: AtprotoFeedPost) => void;
  } = $props();
</script>

{#if show}
  <div
    class="fixed inset-0 bg-black/50 z-50 flex items-center justify-center"
    onclick={onClose}
  >
    <div
      class="bg-white dark:bg-base-800 rounded-lg shadow-xl w-full max-w-2xl h-[70vh] flex flex-col"
      onclick={(e) => e.stopPropagation()}
    >
      <div class="flex-shrink-0 p-4 border-b border-base-300 dark:border-base-700 flex items-center justify-between">
        <h2 class="text-lg font-semibold flex items-center gap-2">
          <Icon icon="mdi:eye-off" />
          Hidden Items
        </h2>
        <button
          onclick={onClose}
          class="p-1 rounded-full hover:bg-base-100 dark:hover:bg-base-700"
        >
          <Icon icon="mdi:close" class="size-5" />
        </button>
      </div>
      <div class="flex-1 overflow-y-auto p-4 space-y-2">
        {#if hiddenPosts.length === 0}
          <div class="text-center py-8 text-base-content/60">
            <Icon icon="mdi:eye-off-outline" class="size-12 mx-auto mb-2" />
            <p>No hidden items</p>
          </div>
        {:else}
          {#each hiddenPosts as post (post.uri)}
            <div class="flex items-center justify-between gap-3 p-2 bg-base-100 dark:bg-base-700 rounded">
              <div class="flex-1 min-w-0">
                <div class="text-sm font-medium truncate">
                  {post.author.displayName || post.author.handle}
                </div>
                <div class="text-xs text-base-content/60 truncate">
                  {post.record.text}
                </div>
              </div>
              <button
                onclick={() => onUnhide(post)}
                class="px-2 py-1 text-xs text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded transition-colors"
                title="Unhide this post"
              >
                <Icon icon="mdi:eye" class="size-4" />
              </button>
            </div>
          {/each}
        {/if}
      </div>
    </div>
  </div>
{/if}
