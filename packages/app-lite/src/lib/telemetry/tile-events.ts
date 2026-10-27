/**
 * Product events for Web Tiles: how many people see a tile, how many open
 * one, and how many messages carry one.
 *
 * `TileEmbed` lives in `@roomy/design`, a component library with no
 * application dependencies, so it does not report anything itself: it
 * announces `roomy:tile-activity` on the DOM and this module is the app's one
 * listener. One seam for all four surfaces that render a tile — chat, search,
 * the activity feed and the debugging page.
 *
 * Identity: a tile is named by the first 16 hex characters of
 * `sha256(<bare tile AT-URI>)`, with no salt. That AT-URI embeds the tile
 * author's DID, and a DID is a durable, cross-service identifier that the Web
 * Tiles plan's instrumentation section (§10) forbids in event properties. The
 * digest is a fingerprint of a public record — the tile's manifest, addressed
 * the same way for every reader — not of a person: it is stable across users
 * and sessions for one tile, and it does not yield the DID back. A salted
 * hash, as used for the telemetry user (`./scrub.ts`), would do the opposite —
 * the same tile would count as a different tile per deployment and per
 * session, and "how many people opened this tile" is not answerable from that.
 *
 * Nothing else leaves the device with an event: no room id, no space id, no
 * message text, no raw URI.
 */

import {
  TILE_ACTIVITY_EVENT,
  type TileActivityDetail,
} from "@roomy/design/components/content/thread/message/tiles/tile-activity.js";
import { trackEvent, type EventAttributes } from "./faro";

/** Where a `tile_post`'s tiles came from, when both are present. */
export type TilePostSource = "inline" | "attachment";

/** How many characters of the tile digest name a tile in telemetry. */
const TILE_ID_LENGTH = 16;

/** `sessionStorage`, or `undefined` where the browser refuses to give it up. */
export interface StringStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * A tile's telemetry name: the first 16 lower-case hex characters of the
 * sha256 of its bare AT-URI. See the module header for why it is a digest and
 * not a salt.
 */
export async function hashTileUri(uri: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(uri));
  let hex = "";
  for (const byte of new Uint8Array(digest)) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex.slice(0, TILE_ID_LENGTH);
}

/**
 * The Faro event name for each render phase. Written out rather than derived
 * from the phase, so the names the dashboard queries by appear in the source
 * as the same literals a query uses.
 */
export const TILE_EVENT_BY_PHASE: Record<TileActivityDetail["phase"], string> = {
  view: "tile_view",
  expand: "tile_expand",
  error: "tile_error",
};

/** The `sessionStorage` key that records one tile's report of a phase. */
export function tileDedupeKey(
  phase: "view" | "expand",
  tile: string,
): string {
  return `tile-${phase}:${tile}`;
}

/**
 * Whether this session may report `phase` for `tile`, claiming the key when it
 * may. Views and expansions are counted once per session per tile: a room
 * re-renders its messages constantly (scrolling, edits, incoming events), so
 * reporting each mount would count renders, not people.
 *
 * A store that is absent or throws is not a reason to lose the event — a
 * browser that refuses `sessionStorage` still has a tile someone looked at — so
 * the claim succeeds there and no dedupe happens.
 */
export function claimTileReport(store: StringStore | undefined, key: string): boolean {
  if (!store) return true;
  try {
    if (store.getItem(key) !== null) return false;
    store.setItem(key, "1");
    return true;
  } catch {
    return true;
  }
}

/** The attributes of a `tile_view` / `tile_expand` / `tile_error` event. */
export function tileActivityAttributes(
  detail: TileActivityDetail,
  tile: string,
): EventAttributes {
  const attributes: EventAttributes = {
    tile,
    surface: detail.surface,
  };
  if (detail.phase === "error") attributes.reason = detail.reason;
  return attributes;
}

/** The attributes of a `tile_post` event. */
export function tilePostAttributes(
  count: number,
  source: TilePostSource,
): EventAttributes {
  return { count: String(count), source };
}

/** Emit `tile_post` for a message that carried at least one tile. */
export function trackTilePost(count: number, source: TilePostSource): void {
  if (count <= 0) return;
  trackEvent("tile_post", tilePostAttributes(count, source));
}

/** `sessionStorage` where it can be read, `undefined` where it throws. */
function dedupeStore(): StringStore | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

/** Turn one announcement into a telemetry event, if it is one worth sending. */
async function report(detail: TileActivityDetail): Promise<void> {
  const tile = await hashTileUri(detail.uri);
  if (detail.phase === "view" || detail.phase === "expand") {
    if (!claimTileReport(dedupeStore(), tileDedupeKey(detail.phase, tile))) return;
  }
  trackEvent(TILE_EVENT_BY_PHASE[detail.phase], tileActivityAttributes(detail, tile));
}

/** One listener for the process; a second call to init is inert. */
let installed = false;

/**
 * Start listening for tile activity. Called once from the root layout, beside
 * `initFaro`; a second call is inert, and there is nothing to listen on during
 * server rendering.
 */
export function initTileTelemetry(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener(TILE_ACTIVITY_EVENT, (event) => {
    const detail = (event as CustomEvent<TileActivityDetail | undefined>).detail;
    if (!detail || typeof detail.uri !== "string" || detail.uri === "") return;
    void report(detail);
  });
}
