<!--
  A Web Tile rendered in Roomy.

  Takes a tile's AT-URI and renders it: the manifest card first (metadata only,
  cheap), and the tile's own content in a sandboxed iframe once the card is
  clicked. The card's click handler is the loader's — it replaces the card with
  the content frame in place — so this component only supplies the container.

  The tile's assets come from its PDS, never from Roomy: `ATTileLoader` fetches
  the manifest record and serves each manifest path as a blob from the same
  repository. There is no host data channel, and nothing about the tile reaches
  the app's own data model.

  The loader is browser-only and heavy (zip, mime, TOML), so it is reached
  through `./mothership.ts` — a dynamic import that runs on first render,
  keeping the packages out of the base bundle.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { getTileMothership } from "./mothership.js";
  import { parseTileAddress, TILE_COLLECTION } from "./at-uri.js";

  type Props = {
    /** The `ing.dasl.masl` record to render. */
    uri: string;
  };

  let { uri }: Props = $props();

  let container: HTMLDivElement | undefined = $state();
  let box: HTMLDivElement | undefined = $state();
  let error: string | null = $state(null);
  /** The card is in place (the loader swaps it for the content frame itself). */
  let placed = $state(false);

  // Attached directly rather than declared in the markup: this is a container,
  // not a control, and the handler exists only to keep a click inside it from
  // reaching a row that is a link (see the markup's note). Svelte reads a
  // `role`-less `<div onclick={…}>` as a misuse; a bare stopPropagation on a
  // wrapper it cannot know is a wrapper is not one.
  $effect(() => {
    const el = box;
    if (!el) return;
    const stop = (e: Event) => e.stopPropagation();
    el.addEventListener("click", stop);
    return () => el.removeEventListener("click", stop);
  });

  // The address is checked before anything loads, so a string that is not a
  // tile record gets a reason rather than the loader's blanket "no loader
  // matched" — `ATTileLoader` declines a malformed URI and a non-masl
  // collection with the same `false`.
  const problem = $derived(
    parseTileAddress(uri) === null
      ? `Not a Web Tile address — expected at://<did:plc:…>/${TILE_COLLECTION}/<rkey>.`
      : null,
  );

  onMount(() => {
    if (parseTileAddress(uri) === null) return;
    // `renderCard` builds detached DOM, so the card is placed once and the
    // loader swaps it for the content frame itself.
    let cancelled = false;
    void (async () => {
      try {
        const mothership = await getTileMothership();
        const tile = await mothership.loadTile(uri);
        if (cancelled) return;
        if (!tile) {
          error =
            "No loader matched that address, or its manifest could not be read from its PDS.";
          return;
        }
        const card = await tile.renderCard();
        if (cancelled) return;
        container?.replaceChildren(card);
        placed = true;
      } catch (err) {
        if (!cancelled) error = err instanceof Error ? err.message : String(err);
      }
    })();
    return () => {
      cancelled = true;
    };
  });
</script>

<!-- The box around a tile. A click inside it belongs to the tile, so it does
     not continue to whatever row encloses the message: two surfaces render a
     message inside a row that is itself a `role="link"` control (the search
     results, whose rows navigate to the room), where an unstopped click would
     mount the tile and navigate away in the same gesture. The loader's own card
     handler sits on a child of this node and has already run by then. -->
<div
  bind:this={box}
  class="not-prose my-1 max-w-full overflow-hidden rounded-lg border border-base-300 dark:border-base-700"
>
  <!-- The container stays mounted whatever the load did: a card, a message, or
       nothing at all until one arrives. -->
  <div bind:this={container}></div>
  {#if problem}
    <p class="px-4 py-3 text-sm text-base-500 dark:text-base-400">{problem}</p>
  {:else if error}
    <p class="px-4 py-3 text-sm text-base-500 dark:text-base-400">
      This tile could not be loaded: {error}
    </p>
  {:else if !placed}
    <!-- The first fetch is a `plc.directory` lookup plus a record read from
         the tile's PDS, so the box is not empty for a moment — it says what it
         is waiting for. The line is replaced by the card in place, so the
         message does not shift when it arrives. -->
    <p class="px-4 py-3 text-sm text-base-500 dark:text-base-400">
      Loading tile…
    </p>
  {/if}
</div>
