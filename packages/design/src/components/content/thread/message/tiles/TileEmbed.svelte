<!--
  A Web Tile rendered in Roomy.

  Takes a tile's AT-URI and renders it: the manifest card first (metadata only,
  cheap), and the tile's own content in a sandboxed iframe once the card is
  clicked. The tile's assets come from its PDS, never from Roomy: `ATTileLoader`
  fetches the manifest record and serves each manifest path as a blob from the
  same repository. Nothing about the tile reaches the app's own data model.

  A tile attached to a message can also be handed JSON — the attachment's
  `data` — over the tiles data-passing protocol. That path is driven here
  rather than by the loader's `renderCard`: the payload is addressed to a
  shuttle id, and the frame has to carry the id the loader's own title and icon
  handoff uses, so the frame's attachment goes through `attachTileFrame` (see
  `./mothership.ts`), which attaches it the loader's way and reports the id
  back. A data-carrying tile gets a card drawn from the same manifest fields
  and, on click, that frame. `renderCard` remains the path for a tile with no
  payload.

  The loader is browser-only and heavy (zip, mime, TOML), so it is reached
  through `./mothership.ts` — a dynamic import that runs on first render,
  keeping the packages out of the base bundle.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import type { Tile } from "@dasl/tile-loader";
  import { getTileMothership, type TileFrameMothership } from "./mothership.js";
  import { parseTileAddress, TILE_COLLECTION } from "./at-uri.js";
  import {
    classifyTileError,
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

  let container: HTMLDivElement | undefined = $state();
  let box: HTMLDivElement | undefined = $state();
  let card: HTMLButtonElement | undefined = $state();
  let error: string | null = $state(null);
  /** A card is in place: the loader's own, or the one drawn below. */
  let placed = $state(false);
  /** The tile's frame has replaced the card. */
  let mounted = $state(false);
  /** A `view` has been announced for this instance; the listener dedupes. */
  let viewAnnounced = false;

  /** Card metadata, read from the tile's manifest. */
  let tileName = $state("");
  let tileDescription = $state<string | undefined>(undefined);
  let iconUrl = $state<string | null>(null);
  let screenshotUrl = $state<string | null>(null);
  /** Handles the click handler addresses. */
  let mothership: TileFrameMothership | undefined;
  let tile: Tile | undefined;
  /** Height of the tile's own frame, from its manifest. */
  let contentHeight = 300;
  /** Blob URLs created for the card, revoked when the component goes away. */
  const blobUrls: string[] = [];

  /** How long a card must stay on screen before it counts as seen. */
  const VIEW_DWELL_MS = 1000;
  /** How much of the card must be on screen to count. */
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

  // A card scrolled past in a busy room is not a tile anyone looked at, so a
  // view is a card at least half on screen for a full second. One per
  // instance: the host's listener is what dedupes across re-mounts and
  // sessions.
  onMount(() => {
    const el = box;
    if (!el || parseTileAddress(uri) === null) return;
    if (typeof IntersectionObserver === "undefined") return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const seen =
            entry.isIntersecting && entry.intersectionRatio >= VIEW_VISIBLE_RATIO;
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
    return () => {
      observer.disconnect();
      stop();
    };
  });

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

  // The card's own listener is attached natively, not through `onclick`: the
  // wrapper below stops propagation on this node, and a delegated handler
  // living further up the tree would never see the click.
  $effect(() => {
    const el = card;
    if (!el) return;
    const go = () => openTile();
    el.addEventListener("click", go);
    return () => el.removeEventListener("click", go);
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

  /** Fetch one manifest resource as an object URL, or `null` if it is unreadable. */
  async function resolveAsset(t: Tile, src: string | undefined): Promise<string | null> {
    if (!src) return null;
    try {
      const res = await t.resolvePath(src);
      if (!res.ok) return null;
      const contentType = res.headers["content-type"];
      // A `Uint8Array` view may sit on a `SharedArrayBuffer`, which `BlobPart`
      // does not accept; a copy lands it on an ordinary one.
      const body = res.body;
      const part: BlobPart =
        body instanceof Uint8Array ? body.slice().buffer : body;
      const blob = new Blob([part], contentType ? { type: contentType } : {});
      const url = URL.createObjectURL(blob);
      blobUrls.push(url);
      return url;
    } catch {
      return null;
    }
  }

  /** Detaches what `openTile` attached, so a teardown leaves no listener behind. */
  let detach: (() => void) | undefined;

  /**
   * Replace the card with the tile's frame and hand it the payload.
   *
   * `attachTileFrame` registers the frame on the loader's own path and returns
   * the id it landed on, which is what makes the frame addressable afterwards:
   * the mothership posts `{ id, action, payload }` into it, and the shuttle
   * forwards that down to the tile. That id is also the one the loader's own
   * title and icon handoff posts to, so the tile is named as it loads.
   *
   * The payload goes down on two signals, because the tile decides when it can
   * accept one and the loader exposes nothing for that. The loader's `load`
   * event is the worker being ready: early enough that the shuttle holds the
   * message until the tile's frame has loaded, but not late enough — the tile's
   * own handlers may not exist yet. `tiles-protocol-up-data-ready` is the tile
   * calling `listen()`, which is the tile saying they do. `data.js` dispatches
   * to the handlers registered at the instant the message arrives and buffers
   * nothing, so answering both is what keeps a tile that registers its handler
   * in a `load` callback of its own from rendering with no data at all.
   */
  function openTile() {
    const m = mothership;
    const t = tile;
    const el = container;
    if (!m || !t || !el) return;

    const ifr = document.createElement("iframe");
    ifr.src = m.getLoadSource();
    ifr.title = tileName || "Web Tile";
    ifr.style.display = "block";
    ifr.style.width = "100%";
    ifr.style.height = `${contentHeight}px`;
    ifr.style.border = "none";

    // Also starts the shuttle on the frame's `load`, as the loader does.
    const id = m.attachTileFrame(t, ifr);
    // The same payload on both signals: a tile that never calls `listen()` is
    // still handed one, and a tile that calls it twice is handed it twice,
    // which the protocol's handlers tolerate.
    const deliver = () =>
      m.sendToShuttle(id, "tiles-protocol-down-data-payload", data);
    const onReady = (ev: MessageEvent) => {
      // Upstream protocol messages reach this page from the shuttle's own
      // window, so the frame that sent it is what identifies the tile.
      if (ev.source !== ifr.contentWindow) return;
      const action = (ev.data as { action?: unknown } | null)?.action;
      if (action !== "tiles-protocol-up-data-ready") return;
      deliver();
    };
    t.addEventListener("load", deliver);
    window.addEventListener("message", onReady);
    detach = () => {
      t.removeEventListener("load", deliver);
      window.removeEventListener("message", onReady);
    };

    el.replaceChildren(ifr);
    mounted = true;
    // The click mounted the tile's frame: the card is what was expanded.
    announce({ phase: "expand", uri, surface });
  }

  onMount(() => {
    if (parseTileAddress(uri) === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const instance = await getTileMothership();
        const loaded = await instance.loadTile(uri);
        if (cancelled) return;
        if (!loaded) {
          error =
            "No loader matched that address, or its manifest could not be read from its PDS.";
          announce({ phase: "error", uri, surface, reason: "manifest" });
          onerror?.("manifest");
          return;
        }
        if (data === undefined) {
          // `renderCard` builds detached DOM, so the card is placed once and
          // the loader swaps it for the content frame itself. The swap happens
          // inside the loader, so the click — the thing that mounts the frame
          // — is what this path can observe.
          const element = await loaded.renderCard();
          if (cancelled) return;
          element.addEventListener("click", () =>
            announce({ phase: "expand", uri, surface }),
          );
          container?.replaceChildren(element);
        } else {
          mothership = instance;
          tile = loaded;
          tileName = loaded.manifest.name ?? "";
          tileDescription = loaded.manifest.description;
          contentHeight = loaded.manifest.sizing?.height ?? 300;
          const [icon, screenshot] = await Promise.all([
            resolveAsset(loaded, loaded.manifest.icons?.[0]?.src),
            resolveAsset(loaded, loaded.manifest.screenshots?.[0]?.src),
          ]);
          if (cancelled) return;
          iconUrl = icon;
          screenshotUrl = screenshot;
        }
        placed = true;
      } catch (err) {
        if (cancelled) return;
        error = err instanceof Error ? err.message : String(err);
        const reason = classifyTileError(err);
        announce({ phase: "error", uri, surface, reason });
        onerror?.(reason);
      }
    })();
    return () => {
      cancelled = true;
      detach?.();
      for (const url of blobUrls) URL.revokeObjectURL(url);
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
  {#if placed && data !== undefined && !mounted}
    <!-- The card for a tile this component drives. A button, because it is
         the control that mounts the tile; the loader's card is a div. -->
    <button
      bind:this={card}
      type="button"
      class="block w-full cursor-pointer text-left"
    >
      {#if screenshotUrl}
        <span
          class="block aspect-video w-full bg-cover bg-center"
          style="background-image: url({screenshotUrl})"
        ></span>
      {/if}
      <span class="flex items-center px-4 py-2">
        {#if iconUrl}
          <img src={iconUrl} width="48" height="48" alt="" class="mr-2 size-12 object-contain" />
        {/if}
        <span class="font-bold">{tileName || "Untitled Tile"}</span>
      </span>
      {#if tileDescription}
        <span class="mx-4 mb-4 mt-2 block text-sm text-base-500 dark:text-base-400">
          {tileDescription}
        </span>
      {/if}
    </button>
  {/if}
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
