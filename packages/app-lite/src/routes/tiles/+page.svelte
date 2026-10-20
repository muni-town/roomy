<!--
  Debugging surface for Web Tiles.

  Milestone A of the Web Tiles plan renders a standalone tile from a hand-placed
  AT-URI; nothing in the product produces one yet. This route is the way to
  exercise the pipeline — it takes the address in the query string and mounts
  `TileEmbed`:

      http://127.0.0.1:5180/tiles?tile=at://did:plc:…/ing.dasl.masl/3mcjwwoqjqs2v

  The auth guard is lifted here because a tile needs no session: the manifest
  and its resources are read straight from the tile's PDS.

  Nothing links here and no navigation entry points at it, so the route is
  reachable only by typing its URL. It carries no product surface — it is one
  page that renders the component a future message attachment will render.
-->
<script lang="ts">
  import { page } from "$app/state";
  import { requireAuth } from "$lib/components/layout/auth-guard.svelte";
  import TileEmbed from "@roomy/design/components/content/thread/message/tiles/TileEmbed.svelte";

  requireAuth.value = false;

  const tile = $derived(page.url.searchParams.get("tile") ?? "");
</script>

<div class="mx-auto max-w-2xl p-6">
  <h1 class="mb-4 text-lg font-semibold">Web Tile</h1>
  {#if tile}
    <TileEmbed uri={tile} />
  {:else}
    <p class="text-sm text-base-500 dark:text-base-400">
      Pass a tile address as <code>?tile=at://…/ing.dasl.masl/…</code>.
    </p>
  {/if}
</div>
