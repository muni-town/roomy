<!--
  A Web Tile rendered in Roomy.

  Takes a tile's AT-URI and renders it: the manifest is read from the tile's
  PDS and the tile's own content runs — immediately, with no card and no click
  — in a sandboxed iframe. The tile's assets come from its PDS, never from
  Roomy: `ATTileLoader` fetches the manifest record and serves each manifest
  path as a blob from the same repository. Nothing about the tile reaches the
  app's own data model.

  The frame does not live in this component's tree. The surfaces that render
  tiles virtualise their rows, which destroys this component — and an iframe
  with it — as soon as its message leaves the window, so the frame is owned by
  `./tile-host.ts`: an overlay positioned over the box below, kept mounted
  after this component goes away and reused when the message scrolls back.

  A tile attached to a message can also be handed JSON — the attachment's
  `data` — over the tiles data-passing protocol, addressed to the shuttle id
  the loader's own title and icon handoff uses; that delivery belongs to the
  retained frame, not to this component, so it is not repeated on a reattach.

  What is left here is the placeholder — a sizing box that reserves the tile's
  height so the message does not jump — plus the error state and the view
  announcement. The loader is browser-only and heavy (zip, mime, TOML), so it
  is reached through `./mothership.ts` — a dynamic import that runs on first
  render, keeping the packages out of the base bundle.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { attachTile, detachTile, type TileHandle } from "./tile-host.js";
  import { parseTileAddress, TILE_COLLECTION } from "./at-uri.js";
  import { tileRenderKey } from "./message-tiles.js";
  import {
    TILE_ACTIVITY_EVENT,
    type TileActivityDetail,
    type TileErrorReason,
    type TileSurface,
  } from "./tile-activity.js";

  type Props = {
    /** The `ing.dasl.masl` record to render. */
    uri: string;
    /**
     * JSON handed to the tile over the data-passing protocol once it is
     * ready. Absent for a tile that renders its own content.
     */
    data?: unknown;
    /**
     * Which surface is rendering the tile. Only the render site knows, so it
     * is passed in and travels with each activity announcement.
     */
    surface?: TileSurface;
    /**
     * Called when the tile could not be loaded. A host that has something else
     * to show for the same content — a link's OpenGraph card, say — uses this
     * to fall back rather than leave an error where a card belongs.
     */
    onerror?: (reason: TileErrorReason) => void;
  };

  let { uri, data, surface = "chat", onerror }: Props = $props();

  /** The sizing box the host draws the tile over. */
  let box: HTMLDivElement | undefined = $state();
  let error: string | null = $state(null);
  /** The manifest is read and the frame is mounted over the box. */
  let ready = $state(false);
  /** A `view` has been announced for this instance; the listener dedupes. */
  let viewAnnounced = false;

  /** How long the box must stay on screen before it counts as seen. */
  const VIEW_DWELL_MS = 1000;
  /** How much of the box must be on screen to count. */
  const VIEW_VISIBLE_RATIO = 0.5;

  /**
   * Announce one phase of this tile's use.
   *
   * Dispatch on the component's own box, so the event bubbles out to whatever
   * the host installed a listener on. Nothing in this package listens, which
   * is what leaves the event inert where no host wants it, and what keeps
   * telemetry out of this library: `uri` leaves here raw and the host decides
   * what may be recorded.
   */
  function announce(detail: TileActivityDetail): void {
    box?.dispatchEvent(
      new CustomEvent<TileActivityDetail>(TILE_ACTIVITY_EVENT, {
        detail,
        bubbles: true,
        composed: true,
      }),
    );
  }

  // The address is checked before anything is attached, so a string that is
  // not a tile record gets a reason rather than the loader's blanket "no
  // loader matched" — `ATTileLoader` declines a malformed URI and a non-masl
  // collection with the same `false`.
  const problem = $derived(
    parseTileAddress(uri) === null
      ? `Not a Web Tile address — expected at://<did:plc:…>/${TILE_COLLECTION}/<rkey>.`
      : null,
  );

  onMount(() => {
    const el = box;
    if (!el || parseTileAddress(uri) === null) return;

    // The key is the rendered tile's identity: record plus payload. Two
    // messages linking the same post share it, which is what lets the frame be
    // reused rather than loaded twice.
    const key = tileRenderKey(uri, data);
    const handle: TileHandle | undefined = attachTile(
      key,
      {
        uri,
        data,
        onReady: () => {
          ready = true;
        },
        onError: (reason, message) => {
          error = message ?? "the tile's manifest could not be read";
          announce({ phase: "error", uri, surface, reason });
          onerror?.(reason);
        },
      },
      el,
    );

    // A box scrolled past in a busy room is not a tile anyone looked at, so a
    // view is the box at least half on screen for a full second. One per
    // instance: the host's listener is what dedupes across re-mounts and
    // sessions.
    let observer: IntersectionObserver | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (typeof IntersectionObserver !== "undefined") {
      const stop = () => {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
      };
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const seen =
              entry.isIntersecting &&
              entry.intersectionRatio >= VIEW_VISIBLE_RATIO;
            if (!seen) {
              stop();
            } else if (timer === undefined && !viewAnnounced) {
              timer = setTimeout(() => {
                timer = undefined;
                viewAnnounced = true;
                announce({ phase: "view", uri, surface });
              }, VIEW_DWELL_MS);
            }
          }
        },
        { threshold: VIEW_VISIBLE_RATIO },
      );
      observer.observe(el);
    }

    return () => {
      observer?.disconnect();
      if (timer !== undefined) clearTimeout(timer);
      detachTile(key, handle);
    };
  });
</script>

<!-- The box around a tile. It reserves the tile's height; the frame is drawn
     over it by the tile host, so the box itself is never a control. -->
<div
  bind:this={box}
  data-tile-placeholder={uri}
  class="not-prose my-1 max-w-full overflow-hidden rounded-lg border border-base-300 dark:border-base-700"
>
  {#if problem}
    <p class="px-4 py-3 text-sm text-base-500 dark:text-base-400">{problem}</p>
  {:else if error}
    <p class="px-4 py-3 text-sm text-base-500 dark:text-base-400">
      This tile could not be loaded: {error}
    </p>
  {:else if !ready}
    <!-- The first fetch is a `plc.directory` lookup plus a record read from
         the tile's PDS, so the box is not empty for a moment. Status, not a
         control: the frame replaces it in place. -->
    <p class="px-4 py-3 text-sm text-base-500 dark:text-base-400">
      Loading tile…
    </p>
  {/if}
</div>
