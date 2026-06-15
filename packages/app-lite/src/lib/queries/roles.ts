import { createQuery } from "@tanstack/svelte-query";
import { cache, schemas } from "@roomy-space/sdk";
import { px } from "$lib/auth.svelte";

const { queryKey } = cache;

export type Role = typeof schemas.queries.getRoles.Role.infer;

export function createRolesQuery(spaceId: () => string) {
  return createQuery(() => ({
    queryKey: queryKey("space.roomy.space.getRoles", { spaceId: spaceId() }),
    queryFn: () =>
      px().query("space.roomy.space.getRoles", { spaceId: spaceId() }),
  }));
}
