import { createQuery } from "@tanstack/svelte-query";
import { transport, cache, schemas } from "@roomy-space/sdk";
import { px } from "$lib/auth.svelte";

const { agentQuery } = transport;
const { queryKey } = cache;

export type Member = typeof schemas.queries.getMembers.Member.infer;
export type ExternalAdmin = typeof schemas.queries.getMembers.ExternalAdmin.infer;

export function createMembersQuery(spaceId: () => string) {
  return createQuery(() => ({
    queryKey: queryKey("space.roomy.space.getMembers", { spaceId: spaceId() }),
    queryFn: () =>
      agentQuery(px(), "space.roomy.space.getMembers", { spaceId: spaceId() }),
  }));
}
