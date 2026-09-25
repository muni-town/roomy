<script lang="ts">
  import { page } from "$app/state";
  import { createRoomLinksQuery, type Link } from "$lib/queries/links";
  import LinkCard from "@roomy/design/components/content/thread/message/embeds/LinkCard.svelte";

  let {
    emptyMessage = "No links shared yet",
  }: { emptyMessage?: string } = $props();

  const roomId = $derived(page.params.room!);

  const linksQuery = createRoomLinksQuery(() => roomId);

  let links = $derived<Link[]>(linksQuery.data?.pages.flatMap((p) => p.links) ?? []);

  let hasMore = $derived(linksQuery.hasNextPage ?? false);

  function loadMore() {
    linksQuery.fetchNextPage();
  }
</script>

{#if linksQuery.isPending && !linksQuery.data}
  <div class="h-full w-full flex items-center justify-center">
    <div class="text-sm text-base-400 p-2">Loading links…</div>
  </div>
{:else if linksQuery.isError && !linksQuery.data}
  <div class="h-full w-full flex items-center justify-center">
    <div class="text-sm text-red-600 p-2">{linksQuery.error.message}</div>
  </div>
{:else if links.length === 0}
  <div class="h-full w-full flex items-center justify-center">
    <div class="text-sm text-base-400 p-2">{emptyMessage}</div>
  </div>
{:else}
  <div class="h-full min-h-0 overflow-y-auto">
    <div class="flex flex-col gap-3 p-3">
      {#each links as link (link.url)}
        <LinkCard url={link.url} embed={link.embed} />
      {/each}
      {#if hasMore}
        <div class="flex justify-center py-2">
          <button
            type="button"
            class="text-sm text-accent-600 dark:text-accent-400 hover:underline"
            onclick={loadMore}
          >
            Load more
          </button>
        </div>
      {/if}
    </div>
  </div>
{/if}
