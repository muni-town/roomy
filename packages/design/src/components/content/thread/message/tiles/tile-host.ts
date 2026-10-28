/**
 * The overlay a Web Tile's frame is drawn in.
 *
 * The surfaces that render tiles virtualise their rows, and a virtualiser
 * unmounts a row that leaves its window: a frame inside `TileEmbed`'s own tree
 * would be torn down when a message scrolls away and reloaded — manifest, PDS
 * reads, worker, tile state — when it scrolls back. So the frame is not in that
 * tree. The host keeps one overlay `<div>` on `document.body`, absolutely
 * positions each live frame over the placeholder that stands for it, and keeps
 * a frame alive after its placeholder goes.
 *
 * Why an overlay rather than moving the frame element back into the component:
 *
 * - the component's box is a placeholder that reserves the tile's height in the
 *   message, so nothing shifts when the frame arrives; the frame is drawn over
 *   it in viewport coordinates;
 * - a frame is only painted where its placeholder is visible: the overlay is
 *   clipped to the placeholder's clipping ancestors (the scroll viewport among
 *   them) so a tile cannot draw over the composer or the header;
 * - a frame that has appeared once stays mounted off screen, hidden, until the
 *   pool drops it (`./tile-pool.ts`).
 *
 * The overlay sits below the design system's modals and popovers (`z-50`) and
 * above message content (`z-10`–`z-30`), so a modal covers a tile and a tile
 * covers the message it belongs to.
 *
 * Only the geometry is here, plus the loader wiring each frame needs. What is
 * retained, reused and evicted is `TilePool`; everything is guarded on
 * `window`, because the app that imports this module is server-rendered.
 */

import type { Tile } from "@dasl/tile-loader";
import {
  getTileMothership,
  type ShuttleId,
  type TileFrameMothership,
} from "./mothership.js";
import { classifyTileError, type TileErrorReason } from "./tile-activity.js";
import { TilePool, type TilePoolSlot } from "./tile-pool.js";

/** What a placeholder tells the host about the tile it stands for. */
export interface TileHostDescriptor {
  /** The tile's `ing.dasl.masl` record. */
  uri: string;
  /** JSON handed to the tile over the data-passing protocol, if any. */
  data?: unknown;
  /** The tile's frame is mounted. */
  onReady?: () => void;
  /**
   * The tile could not be loaded. A reattach reports a failure again, so a
   * component that scrolls back still shows the reason.
   */
  onError?: (reason: TileErrorReason, message: string | undefined) => void;
}

/**
 * One attach: the tile a placeholder asked for, and the placeholder it drew.
 *
 * A virtualiser mounts the replacement row before tearing down the old one, so
 * two placeholders for the same key briefly coexist. The handle names the
 * placeholder it belongs to, which is what keeps the outgoing component's
 * cleanup from detaching a frame the incoming one has already claimed.
 */
export interface TileHandle {
  readonly key: string;
  readonly placeholder: HTMLElement;
}

/** Retained frames the host keeps alive: the memory ceiling for a session. */
const MAX_RETAINED_TILES = 40;
/** How long a frame is kept after its placeholder went away. */
const IDLE_TILE_MS = 10 * 60 * 1000;
/** Frame height used before a manifest is read, and for a manifest without one. */
const DEFAULT_TILE_HEIGHT = 300;
/**
 * Between message content (`z-10`–`z-30`) and the modals and popovers of the
 * design system (`z-50`), which must be able to cover a tile.
 */
const OVERLAY_Z_INDEX = 40;
/** How far outside the viewport a placeholder still counts as visible. */
const VISIBILITY_MARGIN = "200px 0px";

interface TileInstance {
  readonly key: string;
  /** Pool bookkeeping, attached once the pool has taken this host. */
  slot: TilePoolSlot<TileInstance> | undefined;
  /** The overlay child this instance owns; holds the frame. */
  wrapper: HTMLDivElement;
  frame: HTMLIFrameElement | null;
  /** The placeholder currently drawing this tile, if any. */
  placeholder: HTMLElement | null;
  /** Ancestors clipping the placeholder, fixed while it is attached. */
  clipChain: HTMLElement[];
  /** The descriptor of the placeholder currently drawing this tile. */
  descriptor: TileHostDescriptor | null;
  visible: boolean;
  ready: boolean;
  failure: TileErrorReason | null;
  failureMessage: string | undefined;
  /** The frame's own height, from the manifest once it is read. */
  height: number;
  /** Undoes the payload listeners the instance installed. */
  unlisten: (() => void) | null;
  /** Unregisters and releases the frame from the mothership. */
  releaseFrame: (() => void) | null;
  resize: ResizeObserver | null;
}

let layer: HTMLDivElement | undefined;
let pool: TilePool<TileInstance> | undefined;
let observer: IntersectionObserver | undefined;
let refreshScheduled = false;
const byPlaceholder = new WeakMap<HTMLElement, TileInstance>();

function tilePool(): TilePool<TileInstance> {
  pool ??= new TilePool<TileInstance>({
    limit: MAX_RETAINED_TILES,
    idleLimitMs: IDLE_TILE_MS,
    dispose: disposeInstance,
  });
  return pool;
}

/** The one overlay, created on first use. */
function overlayLayer(): HTMLDivElement {
  if (!layer) {
    layer = document.createElement("div");
    layer.dataset.tileHost = "";
    layer.style.cssText = `position:fixed;inset:0;pointer-events:none;z-index:${OVERLAY_Z_INDEX};`;
    document.body.append(layer);
    // Scroll does not bubble, but a capturing listener sees every scroller —
    // the room's viewport and any other. Passive: the host never prevents
    // scrolling, it only follows it.
    window.addEventListener("scroll", scheduleRefresh, {
      capture: true,
      passive: true,
    });
    window.addEventListener("resize", scheduleRefresh, { passive: true });
  }
  return layer;
}

/** Repaint on the next frame, coalesced: scroll fires far faster than paint. */
function scheduleRefresh(): void {
  if (refreshScheduled) return;
  refreshScheduled = true;
  requestAnimationFrame(() => {
    refreshScheduled = false;
    for (const slot of tilePool().slots) {
      const instance = slot.host;
      if (instance.placeholder && instance.visible) position(instance);
    }
  });
}

/**
 * One observer for every tile: a frame only needs repositioning while its
 * placeholder is near the viewport, and the margin positions a frame a little
 * before it scrolls into view so it never appears at its old coordinates.
 */
function visibilityObserver(): IntersectionObserver {
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const instance = byPlaceholder.get(entry.target as HTMLElement);
        if (!instance) continue;
        instance.visible = entry.isIntersecting;
        if (!entry.isIntersecting) continue;
        if (instance.slot) tilePool().touch(instance.slot);
        scheduleRefresh();
      }
    },
    { rootMargin: VISIBILITY_MARGIN },
  );
  return observer;
}

/**
 * Mount a tile over `placeholder`: the retained frame for `key` if there is
 * one, otherwise a new load. The placeholder is a sizing box only — the frame
 * is drawn over it by the host.
 */
export function attachTile(
  key: string,
  descriptor: TileHostDescriptor,
  placeholder: HTMLElement,
): TileHandle | undefined {
  if (typeof window === "undefined") return undefined;

  const slot = tilePool().acquire(key, () => createInstance(key, descriptor));
  const instance = slot.host;
  instance.slot = slot;
  instance.descriptor = descriptor;
  // The instance may still be mapped to the placeholder of a row that has just
  // been replaced; this attach claims it for the new one.
  if (instance.placeholder && instance.placeholder !== placeholder) {
    byPlaceholder.delete(instance.placeholder);
  }
  instance.placeholder = placeholder;
  instance.visible = true;
  instance.clipChain = clippingAncestors(placeholder);
  byPlaceholder.set(placeholder, instance);

  // Deferred, never `position` synchronously: a ResizeObserver callback that
  // writes layout in the same frame is reported as an undelivered-notification
  // loop, and an uncaught error in this app schedules a page reload.
  instance.resize ??= new ResizeObserver(() => {
    if (instance.slot) tilePool().touch(instance.slot);
    scheduleRefresh();
  });
  instance.resize.observe(placeholder);
  visibilityObserver().observe(placeholder);
  sizePlaceholder(instance);
  position(instance);

  // A reattach re-reports what this instance already knows: the component is
  // seeing the tile for the first time even though the frame is not new.
  if (instance.failure) descriptor.onError?.(instance.failure, instance.failureMessage);
  else if (instance.ready) descriptor.onReady?.();
  return { key, placeholder };
}

/**
 * The placeholder that drew `instance` was destroyed by the virtualiser. The
 * frame stays mounted, hidden, until the pool drops it.
 */
export function detachTile(key: string, handle: TileHandle | undefined): void {
  if (typeof window === "undefined" || !handle) return;
  const instance = byPlaceholder.get(handle.placeholder);
  // The placeholder this handle drew is no longer this tile's: its row was
  // already replaced, and the frame is claimed by the new placeholder.
  if (!instance || instance.key !== key || instance.placeholder !== handle.placeholder) {
    return;
  }

  byPlaceholder.delete(handle.placeholder);
  instance.resize?.disconnect();
  instance.resize = null;
  observer?.unobserve(handle.placeholder);
  instance.placeholder = null;
  instance.clipChain = [];
  instance.descriptor = null;
  instance.visible = false;
  instance.wrapper.style.display = "none";
  if (instance.slot) tilePool().release(instance.slot);
}

function createInstance(key: string, descriptor: TileHostDescriptor): TileInstance {
  const wrapper = document.createElement("div");
  wrapper.dataset.tileUri = descriptor.uri;
  wrapper.style.cssText =
    "position:absolute;top:0;left:0;display:none;overflow:hidden;pointer-events:auto;";
  overlayLayer().append(wrapper);

  const instance: TileInstance = {
    key,
    slot: undefined,
    wrapper,
    frame: null,
    placeholder: null,
    clipChain: [],
    descriptor: null,
    visible: false,
    ready: false,
    failure: null,
    failureMessage: undefined,
    height: DEFAULT_TILE_HEIGHT,
    unlisten: null,
    releaseFrame: null,
    resize: null,
  };
  void load(instance, descriptor);
  return instance;
}

/**
 * Read the manifest and mount the frame. The payload is delivered by
 * listeners on the instance, not on the component: they belong to the frame,
 * so a reattach neither repeats nor misses the delivery.
 */
async function load(
  instance: TileInstance,
  descriptor: TileHostDescriptor,
): Promise<void> {
  try {
    const mothership = await getTileMothership();
    const tile = await mothership.loadTile(descriptor.uri);
    if (!tile) {
      fail(
        instance,
        "manifest",
        "No loader matched that address, or its manifest could not be read from its PDS.",
      );
      return;
    }

    const height = tile.manifest.sizing?.height ?? DEFAULT_TILE_HEIGHT;
    const iframe = document.createElement("iframe");
    iframe.src = mothership.getLoadSource();
    iframe.title = tile.manifest.name || "Web Tile";
    iframe.style.cssText = `position:absolute;top:0;left:0;display:block;border:none;width:100%;height:${height}px`;

    // Also starts the shuttle on the frame's `load`, and reports the id the
    // payload is addressed to.
    const id = mothership.attachTileFrame(tile, iframe);
    instance.releaseFrame = () => mothership.releaseTileFrame(id);
    if (descriptor.data !== undefined) {
      instance.unlisten = deliverPayload(mothership, tile, iframe, id, descriptor.data);
    }

    instance.frame = iframe;
    instance.height = height;
    instance.wrapper.replaceChildren(iframe);
    instance.ready = true;
    sizePlaceholder(instance);
    position(instance);
    instance.descriptor?.onReady?.();
  } catch (err) {
    fail(
      instance,
      classifyTileError(err),
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Hand the tile its payload on the two signals it may be ready for: the
 * loader's `load` event, which is the worker being up, and
 * `tiles-protocol-up-data-ready`, which is the tile calling `listen()`.
 * Answering both is what keeps a tile that registers its handler in a `load`
 * callback of its own from rendering with no data at all.
 */
function deliverPayload(
  mothership: TileFrameMothership,
  tile: Tile,
  iframe: HTMLIFrameElement,
  id: ShuttleId,
  data: unknown,
): () => void {
  const deliver = () =>
    mothership.sendToShuttle(id, "tiles-protocol-down-data-payload", data);
  const onReady = (event: MessageEvent) => {
    // Upstream protocol messages reach this page from the shuttle's own window,
    // so the frame that sent it is what identifies the tile.
    if (event.source !== iframe.contentWindow) return;
    const action = (event.data as { action?: unknown } | null)?.action;
    if (action !== "tiles-protocol-up-data-ready") return;
    deliver();
  };
  tile.addEventListener("load", deliver);
  window.addEventListener("message", onReady);
  return () => {
    tile.removeEventListener("load", deliver);
    window.removeEventListener("message", onReady);
  };
}

function fail(
  instance: TileInstance,
  reason: TileErrorReason,
  message: string | undefined,
): void {
  instance.failure = reason;
  instance.failureMessage = message;
  // A failed tile is a line of text, not a frame: let the box shrink to it.
  if (instance.placeholder) instance.placeholder.style.minHeight = "";
  instance.descriptor?.onError?.(reason, message);
}

/** Reserve the frame's height in the message, so nothing shifts under it. */
function sizePlaceholder(instance: TileInstance): void {
  const el = instance.placeholder;
  if (!el) return;
  if (!instance.ready) {
    el.style.minHeight = `${DEFAULT_TILE_HEIGHT}px`;
    return;
  }
  // `height` is a border-box height in this design system, so the borders are
  // added back: what the frame covers is the box's client area.
  const borders = el.offsetHeight - el.clientHeight;
  el.style.minHeight = "";
  el.style.height = `${instance.height + borders}px`;
}

/**
 * Draw `instance` over its placeholder, clipped to everything that clips the
 * placeholder. The wrapper's transform and size are the visible part; the
 * frame inside it is offset so the same part of the tile shows.
 */
function position(instance: TileInstance): void {
  const el = instance.placeholder;
  const wrapper = instance.wrapper;
  if (!el || !el.isConnected) {
    wrapper.style.display = "none";
    return;
  }
  const rect = el.getBoundingClientRect();
  const clip = clipOf(el, instance.clipChain);
  if (clip.width < 1 || clip.height < 1) {
    wrapper.style.display = "none";
    return;
  }
  wrapper.style.display = "";
  wrapper.style.transform = `translate(${clip.left}px, ${clip.top}px)`;
  wrapper.style.width = `${clip.width}px`;
  wrapper.style.height = `${clip.height}px`;

  const frame = instance.frame;
  if (!frame) return;
  if (instance.slot) tilePool().touch(instance.slot);
  const x = rect.left + el.clientLeft - clip.left;
  const y = rect.top + el.clientTop - clip.top;
  frame.style.width = `${el.clientWidth}px`;
  frame.style.transform = `translate(${x}px, ${y}px)`;
}

const CLIPPING = /^(auto|scroll|hidden|clip)$/;

/**
 * The ancestors that cut the placeholder off, cached for as long as it is
 * attached: the list only changes when the placeholder moves in the tree.
 */
function clippingAncestors(el: HTMLElement): HTMLElement[] {
  const chain: HTMLElement[] = [];
  for (let parent = el.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (CLIPPING.test(style.overflowX) || CLIPPING.test(style.overflowY)) {
      chain.push(parent);
    }
  }
  return chain;
}

/** The visible part of `el`: its rect cut down by its clipping ancestors. */
function clipOf(
  el: HTMLElement,
  chain: readonly HTMLElement[],
): { top: number; left: number; width: number; height: number } {
  const rect = el.getBoundingClientRect();
  let top = rect.top;
  let left = rect.left;
  let bottom = rect.bottom;
  let right = rect.right;
  for (const parent of chain) {
    const clip = parent.getBoundingClientRect();
    top = Math.max(top, clip.top);
    left = Math.max(left, clip.left);
    bottom = Math.min(bottom, clip.bottom);
    right = Math.min(right, clip.right);
  }
  top = Math.max(top, 0);
  left = Math.max(left, 0);
  bottom = Math.min(bottom, window.innerHeight);
  right = Math.min(right, window.innerWidth);
  return {
    top,
    left,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

/** The pool dropped `instance`: nothing of it may keep the frame alive. */
function disposeInstance(instance: TileInstance): void {
  if (instance.placeholder) byPlaceholder.delete(instance.placeholder);
  instance.resize?.disconnect();
  instance.resize = null;
  observer?.unobserve(instance.placeholder ?? instance.wrapper);
  instance.unlisten?.();
  instance.unlisten = null;
  instance.releaseFrame?.();
  instance.releaseFrame = null;
  instance.frame?.remove();
  instance.frame = null;
  instance.wrapper.remove();
  instance.placeholder = null;
  instance.clipChain = [];
  instance.descriptor = null;
  instance.slot = undefined;
}
