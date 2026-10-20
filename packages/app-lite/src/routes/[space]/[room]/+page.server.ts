/**
 * The room's own name for its head. The space context beside it in `data`
 * (name, description, avatar) is the parent layout's anonymous read of
 * `space.roomy.space.getMetadata` — SvelteKit merges parent layout data into a
 * page's `data`, so it arrives without being re-exported here.
 *
 * The room's read is gated by the appserver on read access, so a room in an
 * invite-only space resolves to `null` and the tags fall back — the same
 * outcome as a nonexistent ULID. Both are a served document with site-default
 * metadata, which is what a head must always be.
 */

import { Ulid, type } from "@roomy-space/sdk";
import type { PageServerLoad } from "./$types";
import { publicXrpc, type PublicRoomMeta } from "$lib/server/public-space";

export const load: PageServerLoad = async ({ params, parent }) => {
  const { spaceMeta } = await parent();
  const roomId = params.room;

  // Both reads go to the same appserver, so a space read that produced nothing
  // means the room read would produce nothing for the same reason — no
  // reachable origin, a rate limit, a network failure. Skipping it bounds the
  // wait before the head degrades to one timeout rather than two. A non-ULID
  // segment names no room, which the `[room]` layout's own load already
  // answers with a 404.
  if (!spaceMeta || !roomId || Ulid(roomId) instanceof type.errors) {
    return { roomMeta: null };
  }

  return {
    roomMeta: await publicXrpc<PublicRoomMeta>(
      "space.roomy.room.getMetadata",
      { roomId },
    ),
  };
};
