/**
 * A profile's public fields, for its head. `space.roomy.user.getProfile`
 * ignores auth on the appserver, so this is the same read with or without a
 * session — a profile link unfurls as well as a space link does.
 *
 * The avatar is the one field that needs no mapping here: a Bluesky-native
 * profile already stores an `https://cdn.bsky.app/...` URL, and a Roomy
 * `atblob://` URI is mapped by `resolveBlobUrl` at the point the tag is built.
 */

import type { PageServerLoad } from "./$types";
import { publicXrpc, type PublicProfileMeta } from "$lib/server/public-space";

export const load: PageServerLoad = async ({ params }) => {
  const actor = params.user;
  if (!actor) return { profileMeta: null };

  return {
    profileMeta: await publicXrpc<PublicProfileMeta>(
      "space.roomy.user.getProfile",
      { actor },
    ),
  };
};
