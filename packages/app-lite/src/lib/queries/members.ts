import { createQuery } from "@tanstack/svelte-query";
import { cache, schemas } from "@roomy-space/sdk";
import { px } from "$lib/auth.svelte";

const { queryKey } = cache;

export type Member = typeof schemas.queries.getMembers.Member.infer;
export type ExternalAdmin = typeof schemas.queries.getMembers.ExternalAdmin.infer;

export function createMembersQuery(spaceId: () => string) {
  return createQuery(() => ({
    queryKey: queryKey("space.roomy.space.getMembers", { spaceId: spaceId() }),
    queryFn: () =>
      px().query("space.roomy.space.getMembers", { spaceId: spaceId() }),
  }));
}
