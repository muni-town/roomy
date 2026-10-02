import { error } from "@sveltejs/kit";
import { Ulid, type } from "@roomy-space/sdk";
import type { LayoutLoad } from "./$types";

/**
 * The `[room]` path segment is a room only when it is a ULID. Every other
 * value — a slug, a stray word, a route name someone typed one segment deep —
 * names no room, and the page's read path (messages, room metadata, seen
 * receipts) passes the segment straight into id-expecting XRPC params, which
 * each answer `404 Room not found: <slug>` for a value the appserver was never
 * able to resolve. Reject it here so the room subtree never mounts and the
 * nearest `+error` boundary renders the 404. The same predicate and placement
 * as the `[space]` layout's DID guard, and the same one the internal link
 * parsers use (`parseInternalLinkHref`, `design/utils/markdown.ts`), so every
 * path that decides "is this a room reference" agrees.
 *
 * A slug-based room URL — resolving a name to a ULID — is a different
 * question; this guard only stops a value that names no room from being sent
 * as one.
 */
export const load: LayoutLoad = ({ params }) => {
  const roomId = params.room;
  if (!roomId || Ulid(roomId) instanceof type.errors) {
    throw error(404, `No room at "${roomId ?? ""}"`);
  }
  return {};
};
