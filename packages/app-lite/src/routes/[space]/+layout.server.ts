/**
 * The space's anonymous metadata — the whole `/[space]/…` subtree's read.
 *
 * It lives at the layout, not the space index page, for two reasons: the
 * `SeoMeta` that names a space is rendered by the layout (so it covers a room
 * too), and a nested page reaches its parent layouts' server data — `parent()`
 * and the merged `data` prop both stop at layouts, a sibling page's load is
 * not an ancestor of anything.
 *
 * The first path segment under `/[space]/` is a space only when it is a DID
 * (`did:plc:…` / `did:web:…`). Every other value — app routes like `/profile`
 * or `/blog`, user handles, room names, plain words — must never mount the
 * space layout: the layout's `getMetadata` (space-entry) query would otherwise
 * fire against the appserver for a space that cannot exist, surfacing as 404
 * spam and a ~7 s retry ladder (TanStack default `retry: 3`, 4 requests). So a
 * non-DID is rejected here, before any read, and the nearest `+error` boundary
 * renders the 404. Mirrors the DID guard in `parseInternalLinkHref` /
 * `isSpaceRoomPath`.
 */

import { error } from "@sveltejs/kit";
import type { LayoutServerLoad } from "./$types";
import { publicXrpc, type PublicSpaceMeta } from "$lib/server/public-space";
import { isSpaceId } from "$lib/space-ref";

export const load: LayoutServerLoad = async ({ params }) => {
  const spaceId = params.space;
  if (!spaceId || !isSpaceId(spaceId)) {
    throw error(404, `No space at "${spaceId ?? ""}"`);
  }

  return {
    spaceMeta: await publicXrpc<PublicSpaceMeta>(
      "space.roomy.space.getMetadata",
      { spaceId },
    ),
  };
};
