/**
 * The two Open Graph routes for invite links.
 *
 *   GET /og/space/<space-did>.png   the space's invite card (render.ts)
 *   GET /og/join[/<ref>][?space=<ref>&invite=<token>]
 *                                   the HTML a crawler gets for a join link
 *                                   (html.ts), its og:image the card above
 *
 * The app host's Caddy routes a crawler's `/join` here (see `Caddyfile`);
 * people are still served the SPA. Both routes are anonymous and read only
 * what `space.roomy.space.getMetadata` already answers anonymously.
 *
 * Neither route ever fails the unfurl: a space that cannot be found or drawn
 * gets the site-wide card and copy, never an error page.
 */

import { log } from "../log.ts";
import { fetchAvatar, loadSpaceCard, spaceForHandle, type SpaceCard } from "./card.ts";
import { SITE_OG_IMAGE, renderInvitePage } from "./html.ts";
import { renderSpaceCard, type AvatarImage } from "./render.ts";

/**
 * Bumped whenever the card's design changes, so the version in every
 * og:image URL changes with it and crawlers fetch the new card.
 */
const DESIGN_VERSION = "1";

const CACHE_MAX_ENTRIES = 128;
/** A card drawn with its avatar: until the space changes, within reason. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** A card drawn without the avatar it should have had: retry soon. */
const DEGRADED_TTL_MS = 5 * 60 * 1000;
/** Renders waiting their turn beyond which a request gets the site card. */
const MAX_QUEUED_RENDERS = 8;

const IMAGE_PATH = /^\/og\/space\/([^/]+)\.png$/;
const JOIN_PATH = /^\/og\/join(?:\/([^/]+))?\/?$/;

/**
 * A short hash of everything the card is drawn from. It names the image in
 * the page's og:image URL, so a crawler that caches by URL sees a new card
 * when the space's name, avatar or counts change, and it keys the render
 * cache, so a change is drawn on the next request.
 */
export function cardVersion(card: SpaceCard): string {
  const fields = [
    DESIGN_VERSION,
    card.name,
    card.description ?? "",
    card.handle ?? "",
    card.avatarRef ?? "",
    String(card.memberCount ?? ""),
    String(card.allowPublicJoin ?? ""),
  ];
  return Bun.hash(JSON.stringify(fields)).toString(36);
}

function isSpaceDid(value: string): boolean {
  return /^did:[a-z]+:[A-Za-z0-9._:%-]{1,200}$/.test(value);
}

interface CachedCard {
  version: string;
  png: Buffer;
  expiresAt: number;
}

export interface OgRoutesOptions {
  /** The appserver's public origin, for the absolute og:image URL. */
  serviceEndpoint: string;
  /** Fetches and decodes an avatar. Tests replace it to stay off the network. */
  fetchAvatar?: (ref: string) => Promise<AvatarImage | null>;
}

export function createOgRoutes(opts: OgRoutesOptions) {
  const origin = opts.serviceEndpoint.replace(/\/+$/, "");
  const loadAvatar = opts.fetchAvatar ?? fetchAvatar;
  const cache = new Map<string, CachedCard>();
  const inflight = new Map<string, Promise<CachedCard>>();
  // Rendering is synchronous CPU work on the event loop (~100 ms a card), so
  // renders run one at a time rather than stacking up behind each other.
  // Avatar fetches are I/O and run alongside: a slow avatar host must not
  // hold up every other card.
  let renderQueue: Promise<unknown> = Promise.resolve();
  let drawing = 0;

  function serially<T>(fn: () => Promise<T>): Promise<T> {
    const next = renderQueue.catch(() => {}).then(fn);
    renderQueue = next;
    return next;
  }

  function remember(spaceId: string, entry: CachedCard): void {
    cache.delete(spaceId);
    cache.set(spaceId, entry);
    while (cache.size > CACHE_MAX_ENTRIES) {
      cache.delete(cache.keys().next().value!);
    }
  }

  function draw(spaceId: string, card: SpaceCard, version: string): Promise<CachedCard> {
    const key = `${spaceId}@${version}`;
    const pending = inflight.get(key);
    if (pending) return pending;

    if (drawing >= MAX_QUEUED_RENDERS) {
      return Promise.reject(new Error("og render queue full"));
    }
    drawing += 1;
    const job = (async () => {
      const avatar = card.avatarRef ? await loadAvatar(card.avatarRef) : null;
      const png = await serially(() => renderSpaceCard(card, avatar));
      const degraded = card.avatarRef !== undefined && avatar === null;
      const entry: CachedCard = {
        version,
        png,
        expiresAt: Date.now() + (degraded ? DEGRADED_TTL_MS : CACHE_TTL_MS),
      };
      remember(spaceId, entry);
      return entry;
    })().finally(() => {
      drawing -= 1;
      inflight.delete(key);
    });
    inflight.set(key, job);
    return job;
  }

  /** Send the crawler to the site-wide card. */
  function siteCard(): Response {
    return new Response(null, {
      status: 302,
      headers: { location: SITE_OG_IMAGE, "cache-control": "public, max-age=300" },
    });
  }

  async function image(req: Request, spaceId: string): Promise<Response> {
    if (!isSpaceDid(spaceId)) return new Response("Not found", { status: 404 });

    let card: SpaceCard | null;
    try {
      card = await loadSpaceCard(spaceId);
    } catch (err) {
      log.warn(`[og] could not read space ${spaceId}: ${String(err)}`);
      return siteCard();
    }
    if (card === null) return siteCard();

    const version = cardVersion(card);
    const etag = `"${version}"`;
    if (req.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304, headers: { etag } });
    }

    let entry = cache.get(spaceId);
    if (!entry || entry.version !== version || entry.expiresAt < Date.now()) {
      try {
        entry = await draw(spaceId, card, version);
      } catch (err) {
        log.warn(`[og] could not draw space ${spaceId}: ${String(err)}`);
        return siteCard();
      }
    }

    return new Response(req.method === "HEAD" ? null : new Uint8Array(entry.png), {
      headers: {
        "content-type": "image/png",
        "content-length": String(entry.png.byteLength),
        etag,
        "cache-control": "public, max-age=3600, stale-while-revalidate=86400",
      },
    });
  }

  async function joinPage(url: URL, pathRef: string | undefined): Promise<Response> {
    const ref = (pathRef ?? url.searchParams.get("space") ?? "").trim();
    // Where the link goes in the app: the same path and query, without /og.
    const appHref = `${url.pathname.replace(/^\/og/, "")}${url.search}`;

    let space: Parameters<typeof renderInvitePage>[0]["space"];
    try {
      const spaceId = ref.startsWith("did:") ? ref : ref ? await spaceForHandle(ref) : null;
      const card = spaceId && isSpaceDid(spaceId) ? await loadSpaceCard(spaceId) : null;
      if (spaceId && card) {
        space = {
          name: card.name,
          ...(card.description ? { description: card.description } : {}),
          imageUrl: `${origin}/og/space/${encodeURIComponent(spaceId)}.png?v=${cardVersion(card)}`,
        };
      }
    } catch (err) {
      // The page is still served, with the site's copy and card.
      log.warn(`[og] could not resolve join link space ${ref}: ${String(err)}`);
    }

    return new Response(renderInvitePage({ appHref, ...(space ? { space } : {}) }), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=300",
      },
    });
  }

  /** Answer an `/og/...` request, or `null` when the path is not one. */
  return async function handleOg(req: Request, url: URL): Promise<Response | null> {
    if (!url.pathname.startsWith("/og/")) return null;
    if (req.method !== "GET" && req.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
    }

    const imageMatch = url.pathname.match(IMAGE_PATH);
    if (imageMatch) {
      let spaceId: string;
      try {
        spaceId = decodeURIComponent(imageMatch[1]!);
      } catch {
        return new Response("Not found", { status: 404 });
      }
      return image(req, spaceId);
    }

    const joinMatch = url.pathname.match(JOIN_PATH);
    if (joinMatch) {
      let pathRef: string | undefined;
      try {
        pathRef = joinMatch[1] === undefined ? undefined : decodeURIComponent(joinMatch[1]);
      } catch {
        pathRef = undefined;
      }
      const res = await joinPage(url, pathRef);
      return req.method === "HEAD" ? new Response(null, res) : res;
    }

    return new Response("Not found", { status: 404 });
  };
}
