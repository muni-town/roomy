/**
 * Whether the signed-in user has blocked `actor`.
 *
 * Blocks live in the user's own repo (`space.roomy.user.block`, see
 * `lib/mutations/blocks.ts`), not in the appserver, so this reads the PDS
 * directly rather than going through the XRPC client. The appserver does not
 * materialise the collection — the same arrangement as
 * `space.roomy.user.profile`.
 *
 * Returns the block record (whose `rkey` an unblock needs) or `null`.
 */

import { createQuery } from "@tanstack/svelte-query";
import { auth } from "$lib/auth.svelte";
import { findBlock, type BlockRecord } from "$lib/mutations/blocks";

export function createBlockQuery(
  actor: () => string | undefined,
  enabled: () => boolean,
) {
  return createQuery(() => ({
    queryKey: ["space.roomy.user.block", { actor: actor() }],
    queryFn: (): Promise<BlockRecord | null> => {
      const did = auth.userDid;
      const subject = actor();
      if (!did || !subject) return Promise.resolve(null);
      return findBlock(did, subject);
    },
    enabled: enabled() && !!actor() && !!auth.userDid,
  }));
}
