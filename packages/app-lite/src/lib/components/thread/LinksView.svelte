<script lang="ts">
  import { page } from "$app/state";
  import { createRoomLinksQuery, type Link } from "$lib/queries/links";
  import LinkViewShell from "@roomy/design/components/content/thread/linkView/LinkView.svelte";
  import type { LinkInfo } from "@roomy/design/components/content/thread/linkView/types.ts";
  import ErrorMessage from "@roomy/design/components/helper/ErrorMessage.svelte";

  let {
    emptyMessage = "No links shared yet",
  }: { emptyMessage?: string } = $props();

  const roomId = $derived(page.params.room!);

  const linksQuery = createRoomLinksQuery(() => roomId);

  let links = $derived<LinkInfo[]>(
    (linksQuery.data?.pages.flatMap((p) => p.links) ?? []).map(mapLink),
  );

  let hasMore = $derived(linksQuery.hasNextPage ?? false);

  function loadMore() {
    linksQuery.fetchNextPage();
  }

  function mapLink(l: Link): LinkInfo {
    const embed = l.embed;
    if (!embed) return { url: l.url };
    return {
      url: l.url,
      embed: {
        title: embed.t,
        description: embed.d,
        image: embed.imgs?.[0]?.u ?? embed.thumb?.u,
        video: embed.vid?.u,
        thumbnail: embed.thumb?.u,
        provider: embed.p?.n,
        author: embed.au?.n,
      },
    };
  }
</script>

{#if linksQuery.isPending && !linksQuery.data}
  <div class="h-full w-full flex items-center justify-center">
    <div class="text-sm text-base-400 p-2">Loading links…</div>
  </div>
{:else if linksQuery.isError && !linksQuery.data}
  <ErrorMessage
    message={linksQuery.error.message}
    class="h-full w-full justify-center"
  />
{:else}
  <div class="flex flex-col h-full min-h-0">
    <div class="flex-1 min-h-0">
      <LinkViewShell {links} {emptyMessage} {loadMore} {hasMore} />
    </div>
  </div>
{/if}
