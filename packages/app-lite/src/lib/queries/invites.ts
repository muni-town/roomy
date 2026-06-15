import { createQuery } from "@tanstack/svelte-query";
import { cache, schemas } from "@roomy-space/sdk";
import { px } from "$lib/auth.svelte";

const { queryKey } = cache;

export type Invite = typeof schemas.queries.getInvites.Invite.infer;

export function createInvitesQuery(spaceId: () => string) {
  return createQuery(() => ({
    queryKey: queryKey("space.roomy.space.getInvites", { spaceId: spaceId() }),
    queryFn: () =>
      px().query("space.roomy.space.getInvites", { spaceId: spaceId() }),
  }));
}
