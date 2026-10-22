import { error } from "@sveltejs/kit";
import { Did, type } from "@roomy-space/sdk";
import type { LayoutLoad } from "./$types";

export const ssr = false;

/**
 * The first path segment under `/[space]/` is a space only when it is a DID
 * (did:plc:… / did:web:…). Every other value — app routes like `/profile` or
 * `/blog`, user handles, room names, plain words — must never mount the space
 * layout: the layout's `getMetadata` (space-entry) query would otherwise fire
 * against the appserver for a space that cannot exist, surfacing as 404 spam
 * and a ~7 s retry ladder (TanStack default `retry: 3`, 4 requests). Reject
 * these up front so the layout doesn't mount at all, then let the nearest
 * `+error` boundary render the 404. Mirrors the DID guard in
 * `parseInternalLinkHref` / `isSpaceRoomPath`.
 */
export const load: LayoutLoad = ({ params }) => {
  const spaceId = params.space;
  if (!spaceId || Did(spaceId) instanceof type.errors) {
    throw error(404, `No space at "${spaceId ?? ""}"`);
  }
  return {};
};
