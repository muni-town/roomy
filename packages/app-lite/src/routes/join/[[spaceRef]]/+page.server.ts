/**
 * The space an invite link names, for the link's head.
 *
 * This is the route where the anonymous read matters most: an invite link's
 * unfurl is the invitation's first impression, and a space that allows no
 * public joins is exactly the kind of space an invite link points at. The
 * appserver answers `space.roomy.space.getMetadata` for those by design — it is
 * ungated on membership so the join prompt can render — so the name, description
 * and avatar are readable here without a session.
 *
 * A ref that is a handle needs resolution first (`space-ref.ts`, the Leaf
 * resolver); a ref that names nothing resolvable, or a space that no longer
 * exists, leaves the head on the site defaults.
 */

import type { PageServerLoad } from "./$types";
import { publicXrpc, type PublicSpaceMeta } from "$lib/server/public-space";
import { resolveSpaceRef } from "$lib/space-ref";

export const load: PageServerLoad = async ({ params, url }) => {
  // Either shape of join link: the path form (`/join/<ref>`) or the query form
  // built by `inviteUrl` (`/join?space=<ref>&invite=<token>`).
  const ref = params.spaceRef ?? url.searchParams.get("space") ?? "";
  const spaceId = ref ? await resolveSpaceRef(ref) : null;
  if (!spaceId) return { spaceMeta: null };

  return {
    spaceMeta: await publicXrpc<PublicSpaceMeta>(
      "space.roomy.space.getMetadata",
      { spaceId },
    ),
  };
};
