import { createQuery } from "@tanstack/svelte-query";
import { transport, cache, schemas } from "@roomy-space/sdk";
import { px } from "$lib/auth.svelte";

const { agentQuery } = transport;
const { queryKey } = cache;

export type Invite = typeof schemas.queries.getInvites.Invite.infer;

export function createInvitesQuery(spaceId: () => string) {
  return createQuery(() => ({
    queryKey: queryKey("space.roomy.space.getInvites", { spaceId: spaceId() }),
    queryFn: () =>
      agentQuery(px(), "space.roomy.space.getInvites", { spaceId: spaceId() }),
  }));
}
